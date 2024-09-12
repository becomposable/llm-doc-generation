import { ComposableClient } from '@becomposable/client';
import { type BaseOptions, BaseProgram, type BasePromptData, type DocSection, executeGeneration, generateDocFromParts, getFilesContent, getFromContext, loadContext, saveToContext, type Toc, writeSectionToDisk, writeTocToDisk } from '.';
import fs from 'fs';
import zlib from 'zlib';

const INTERACTION_NAME = "exp:GenerateAPIDoc"
let PREFIX = 'api-docs';


interface ApiDocOptions extends BaseOptions {
}

interface ApiDocPromptData extends BasePromptData {
    api_endpoint: string;
    api_client: string;
    examples: string;
    types: string;
}


interface BasePromptData {
    already_generated: string;
    part_name: string;
    instruction: string;
    [key]: any;
}

async function generateSection(client: ComposableClient, section: DocSection, options: BaseOptions) {

    const existing = await getFromContext(options.useContext, section.id);
    if (existing) {
        console.log('Section already generated', section.id);
        return existing;
    }

    const context = await loadContext(options.useContext);
    const alreadyGenerated = Object.keys(context).filter(k => k.startsWith("g-")).map(k => context[k]);
    const contextForPrompt = { ...context }
    for (const k of Object.keys(context).filter(k => k.startsWith("g-"))) {
        delete contextForPrompt[k];
    }

    let parts: DocPart[] = [];
    for (const part of (section.parts || [])) {
        const p = await generatePart(client, section, part, options)
        parts.push(p);
    }

    const promptData = {
        ...context,
        already_generated: JSON.stringify(alreadyGenerated),
        part_name: section.id,
        instruction: `Generate the section: ${section.id}`,
    }

    const { modelId, envId } = options;
    const res = await executeGeneration<BasePromptData>(client, INTERACTION_NAME, promptData, envId, modelId);

    saveToContext(options.useContext, { [section.id]: res.result });
    console.log('Section generated and saved to context', section.id, res.result);

}

async function generatePart(client: ComposableClient, section: DocSection, part: DocPart, options: BaseOptions) {

    const partId = `g-${section.id}-${part.id}`
    const existing = await getFromContext(options.useContext, partId);
    if (existing) {
        console.log('Part already generated', partId);
        return existing;
    }

    const context = await loadContext(options.useContext);
    const alreadyGenerated = Object.keys(context).filter(k => k.startsWith("g-")).map(k => context[k]);
    const contextForPrompt = { ...context }
    for (const k of Object.keys(context).filter(k => k.startsWith("g-"))) {
        delete contextForPrompt[k];
    }

    const promptData = {
        ...contextForPrompt,
        already_generated: JSON.stringify(alreadyGenerated),
        part_name: `section: ${section.id} part: ${part.id}`,
        instruction: `Generate the part ${part.id} of section ${section.id}`,
    }

    const { modelId, envId } = options;
    const res = await executeGeneration<BasePromptData>(client, INTERACTION_NAME, promptData, envId, modelId);

    saveToContext(options.useContext, { [partId]: res.result });
    console.log('Part generated and saved to context', partId, res.result);

    return res.result;

}



async function generate(client: ComposableClient, options: ApiDocOptions) {

    const { envId, modelId } = options;
    console.log('Generating Doc with options:', options);

    let docParts: Record<string, DocSection> = {};

    const start = Date.now();
    let model: string = modelId || '';
    let n = 1;

    const serverApiDoc = await getFromContext(options.useContext, 'serverApi') ?? getFilesContent(serverApi, 'serverApi');
    const clientApiDoc = await getFromContext(options.useContext, 'clientApi') ?? getFilesContent(clientApi, 'clientApi');
    const typesDoc = await getFromContext(options.useContext, 'types') ?? getFilesContent(types, 'types');
    const examplesDoc = await getFromContext(options.useContext, 'examples') ?? getFilesContent(examples, 'examples');

    saveToContext(options.useContext, {
        serverApi: serverApiDoc,
        clientApi: clientApiDoc,
        types: typesDoc,
        examples: examplesDoc,
    })

    const commonPromptData = {
        api_endpoint: serverApiDoc,
        api_client: clientApiDoc,
        examples: examplesDoc,
        types: typesDoc,
        instruction: options.instruction,
    }

    let toc = await getFromContext(options.useContext, 'toc') as Toc | undefined;
    if (!toc) {
        console.log('Generating Table of Content...');
        toc = await generateToc(client, INTERACTION_NAME, envId, modelId, commonPromptData)
        console.log(`ToC Generated (${typeof toc})`, { toc })
        saveToContext(options.useContext, { toc });
    }

    console.log(`Starting processing of ${toc.sections.length} sections...`)
    for (const section of toc.sections) {
        const done = await getFromContext(options.useContext, `section-${section.slug}`);
        if (done) {
            console.log(`Skipping ${section.title} ( ${n++} of ${toc.sections.length} ) because it has been already generated...`);
            continue;
        }

        console.log(`Generating ${section.title} ( ${n++} of ${toc.sections.length} )...`);
        const start = Date.now();
        const docState = generateDocFromParts(docParts);
        const waitTime = 3 //in sec

        //generate sections, add exponential backoff and retry if result contains error and too many
        let res;
        let generatedSection: DocSection | undefined;
        for (let i = 0; i < 5; i++) {
            try {
                res = await executeGeneration<ApiDocPromptData>(client, INTERACTION_NAME, {
                    ...commonPromptData,
                    table_of_content: toc,
                    previously_generated: docState,
                    part_name: section.title,
                }, envId, modelId);

                generatedSection = {
                    slug: section.slug,
                    title: section.title,
                    content: res.result,
                    parts: []
                }

                let p = 1;
                if (section?.parts && section?.parts?.length > 0) {
                    for (const part of section.parts) {
                        console.log(`Generating Part ${part.title} ( ${p++} of ${section.parts.length} )...`);
                        const partRes = await executeGeneration(client, INTERACTION_NAME, {
                            ...commonPromptData,
                            table_of_content: toc.sections,
                            previously_generated: docState,
                            part_name: section.title + " > " + part.title,
                            instruction: `${commonPromptData.instruction ?? ''} You are in a subsection of the ${section.title} section.
                            Please use ## for main subsection title, typically endpoints. Title should be a brief description of the command.
                            Like ## Get all users`
                        }, envId, modelId);
                        generatedSection.parts!.push({ title: part.title, content: partRes.result });
                    }
                }
                break;

            } catch (err: any) {
                if (err.message.includes('500') && i < 5) {
                    console.log('Retrying...');
                    await new Promise(resolve => setTimeout(resolve, i < 3 ? 30 * 1000 : 1000 * Math.pow(waitTime, i + 1)));
                } else {
                    throw err;
                }
            }
        }

        if (!res?.result || !generatedSection) {
            console.error('Failed to generate part:', res);
            return;
        }

        model = res.modelId;
        console.log("Generated Section - writing to disk", generatedSection);
        await saveToContext(options.useContext, { ['section-' + section.slug]: section });
        writeSectionToDisk(PREFIX, generatedSection, model);
        const end = Date.now();
        console.log(`Generated ${section.title} in ${(end - start) / 1000}s`);

    }

    //save to file
    console.log(`Construction document from ${Object.keys(docParts).length} parts...`);
    console.log('Generated Doc in', (Date.now() - start) / 1000, 's');


}

//use commander to get envId and modelId
const apiDocGenerator = BaseProgram
    .option('--server-api <serverApi...>', 'Server Endpoints for the API')
    .option('--client-api <clientApi...>', 'code help or using the tool, typically client code')
    .option('--examples <examples...>', 'example of documentation, can be the current one')
    .option('--types <types...>', 'types and interaces used in the code')
    .action((options) => {
        if (options.prefix) {
            PREFIX = options.useContext;
        }
        console.log(`Generating Doc for ${PREFIX}...`, options);
        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.server,
            storeUrl: options.server,
        });
        generate(client, options);
    });

apiDocGenerator.parse(process.argv);
