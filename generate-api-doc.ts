import { ComposableClient } from '@becomposable/client';
import { Command } from 'commander';
import { type BasePromptData, type DocSection, executeGeneration, generateDocFromParts, generateToc, getFilesContent, type Options, writeSectionToDisk, writeTocToDisk } from '.';

const INTERACTION_NAME = "exp:GenerateAPIDoc"
let PREFIX = 'api-docs';


interface ApiDocOptions extends Options {
    serverApi: string[];
    clientApi: string[];
    types: string[];
}

interface ApiDocPromptData extends BasePromptData {
    api_endpoint: string;
    api_client: string;
    examples: string;
    types: string;
}


async function generate(client: ComposableClient, options: ApiDocOptions) {

    const { envId, modelId, serverApi, clientApi, examples, types } = options;
    console.log('Generating Doc with options:', options);

    let docParts: Record<string, DocSection> = {};

    const start = Date.now();
    let model: string = modelId || '';
    let n = 1;


    const serverApiDoc = getFilesContent(serverApi);
    const clientApiDoc = getFilesContent(clientApi);
    const typesDoc = getFilesContent(types);
    const examplesDoc = getFilesContent(examples);

    const commonPromptData = {
        api_endpoint: serverApiDoc,
        api_client: clientApiDoc,
        examples: examplesDoc,
        types: typesDoc,
        instruction: options.instruction,
    }

    const toc = await generateToc(client, INTERACTION_NAME, envId, modelId, commonPromptData)
    console.log('Table of Content:', toc);
    writeTocToDisk(PREFIX, toc);

    for (const section of toc.sections) {
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
        await writeSectionToDisk(PREFIX, generatedSection, model);
        const end = Date.now();
        console.log(`Generated ${section.title} in ${(end - start) / 1000}s`);

    }

    //save to file 
    console.log(`Construction document from ${Object.keys(docParts).length} parts...`);
    console.log('Generated Doc in', (Date.now() - start) / 1000, 's');


}

//use commander to get envId and modelId 
const program = new Command();
program
    .option('-e, --envId <envId>', 'Environment ID')
    .option('-m, --modelId <modelId>', 'Model ID')
    .option('--server-api <serverApi...>', 'Server Endpoint API')
    .option('--client-api <clientApi...>', 'Client API')
    .option('--examples <examples...>', 'examples Doc')
    .option('--types <types...>', 'Types')
    .option('--prefix <prefix>', 'Prefix for the generated files')
    .option('--instruction <instruction>', 'Instruction for the generation')
    .option('-s --server <apiEndpoint>', 'Server API Endpoint')
    .option('-k --token [token]', 'APIKey or JWT Token')

    .action((options) => {
        if (options.prefix) {
            PREFIX = options.prefix;
        }

        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.apiEndpoint,
            storeUrl: options.apiEndpoint,
        });
        console.log(`Generating Doc for ${PREFIX}...`);
        generate(client, options);
    })
    .parse(process.argv);   