import { ComposableClient } from '@becomposable/client';
import { type BaseOptions, BaseProgram, type BasePromptData, type DocSection, executeGeneration, generateDocFromParts, generateToc, getFilesContent, writeSectionToDisk, writeTocToDisk } from '.';

const INTERACTION_NAME = "exp:GenerateCLIDoc"
let PREFIX = 'cli';

interface CliOptions extends BaseOptions {
    toolCode: string[];
}

interface CliPromptData extends BasePromptData {
    cli_code: string;
    examples: string;
}

async function generate(client: ComposableClient, options: CliOptions) {

    const { envId, modelId, toolCode, clientApi, examples, types } = options;
    console.log('Generating Doc with options:', options);

    let docParts: Record<string, DocSection> = {};

    const start = Date.now();
    let model: string = modelId || '';
    let n = 1;


    const cliCodeDoc = getFilesContent(toolCode);
    //const clientApiDoc = getFilesContent(clientApi);
    //const typesDoc = getFilesContent(types);
    const examplesDoc = getFilesContent(examples);

    const commonPromptData = {
        cli_code: cliCodeDoc,
        //api_client: clientApiDoc,
        examples: examplesDoc,
        //types: typesDoc,
        instruction: options.instruction
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
                res = await executeGeneration<CliPromptData>(
                    client,
                    INTERACTION_NAME,
                    {
                        ...commonPromptData,
                        table_of_content: toc,
                        previously_generated: docState,
                        part_name: section.title,
                        instruction: commonPromptData.instruction + "\n\n" + (section?.instructions ?? '')
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
                        const partRes = await executeGeneration(client, INTERACTION_NAME,
                            {
                                ...commonPromptData,
                                table_of_content: toc.sections,
                                previously_generated: docState,
                                part_name: section.title + " > " + part.title,
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
        console.log(`Generated ${section.slug} in ${(end - start) / 1000}s`);

    }

    //save to file 
    console.log(`Construction document from ${Object.keys(docParts).length} parts...`);
    console.log('Generated Doc in', (Date.now() - start) / 1000, 's');


}

const cliDoc = BaseProgram
    .action((options) => {

        if (options.prefix) {
            PREFIX = options.prefix;
        }
        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.apiEndpoint,
            storeUrl: options.apiEndpoint,
        });
        console.log(`Generating Doc for ${PREFIX}...`, options);
        generate(client, options);
    })

    cliDoc.parse(process.argv);