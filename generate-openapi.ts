import { ComposableClient } from '@becomposable/client';
import fs from 'fs';
import { type BaseOptions, BaseProgram, type BasePromptData, type DocSection, executeGeneration, generateDocFromParts, getFilesContent, type Toc } from '.';

const CONTENTDIR = 'content';
const INTERACTION_NAME = "exp:TaskGenerateOpenAPI"
let PREFIX = 'openapi';


interface ApiDocOptions extends BaseOptions {
}

interface OpenApiPromptData extends BasePromptData {
    api_endpoint: string;
    api_client: string;
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

    const commonPromptData = {
        api_endpoint: serverApiDoc,
        api_client: clientApiDoc,
        types: typesDoc,
        instruction: options.instruction,
    }

    const openApiToc: Toc = {
        sections: [            {
            slug: "paths",
            title: "Endpoint",
            description: "List of all the endpoints, types with examples and explanation",
        },
            {
                slug: "components",
                title: "OpenAPI Types",
                description: "List of all the endpoints, types with examples and explanation",
            },
        ]
    }

    for (const section of openApiToc.sections) {
        const start = Date.now();
        const docState = generateDocFromParts(docParts);
        const waitTime = 3 //in sec

        //generate sections, add exponential backoff and retry if result contains error and too many
        let res;
        let generatedSection: DocSection | undefined;
        for (let i = 0; i < 5; i++) {
            try {
                res = await executeGeneration<OpenApiPromptData>(client, INTERACTION_NAME, {
                    ...commonPromptData,
                    table_of_content: openApiToc,
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
                            table_of_content: openApiToc,
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
    
        writeToDisk(generatedSection.content, `${section.slug}.yaml`);
        const end = Date.now();
        console.log(`Generated ${section.slug} in ${(end - start) / 1000}s`);

    }

    //save to file 
    console.log(`Construction document from ${Object.keys(docParts).length} parts...`);
    console.log('Generated Doc in', (Date.now() - start) / 1000, 's');


}

function writeToDisk(content: string, filename: string) {
    const dir = `${CONTENTDIR}/${PREFIX}/`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${filename}`, content);
}


//use commander to get envId and modelId 
const openapiGenerator = BaseProgram
    .action((options: ApiDocOptions) => {
        if (options.prefix) {
            PREFIX = options.prefix;
        }

        if (!options.server) {
            throw new Error('Server URL is required');
        }
        
        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.server,
            storeUrl: options.server,
        });
        console.log(`Generating Doc for ${PREFIX}...`);
        generate(client, options);
    });

openapiGenerator.parse(process.argv);   