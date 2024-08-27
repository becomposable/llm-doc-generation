import { ComposableClient } from '@becomposable/client';
import { Command } from 'commander';
import fs from 'fs';
import zlib from 'zlib';

const CONTENTDIR = 'content';
const CONTEXTDIR = 'context';
let CONTEXT: Record<string, any> | undefined = undefined;

export interface Toc {
    sections: {
        slug: string;
        title: string;
        description: string;
        instructions?: string;
        parts?: {
            slug: string;
            title: string;
            description: string;
            instructions?: string;
        }[]
    }[]
}

export interface BasePromptData {
    instruction?: string;
    previously_generated?: string;
    table_of_content?: Toc;
    part_name: string;
}

export interface DocSection {
    slug: string;
    title: string;
    content: string;
    parts?: DocPart[];
}

export interface DocPart {
    title: string;
    content: string;
}


function getContextFileName(name: string) {
    return `${CONTEXTDIR}/${name}.json.gz`;
}

async function loadContext(name: string): Promise<Record<string, any>> {
    if (CONTEXT) return CONTEXT;

    const contextPath = getContextFileName(name);
    if (fs.existsSync(contextPath)) {
        const data = zlib.gunzipSync(fs.readFileSync(contextPath));
        const contextData = JSON.parse(data.toString());
        console.log('Loaded Context:', Object.keys(contextData));
        return Promise.resolve(contextData);
    } else {
        return {};
    }
}


export async function getFromContext(contextName: string, key: string) {
    console.log('Getting from context:', contextName, key);
    const contextData = await loadContext(contextName);

    if (contextData[key]) {
        console.log('Cache hit for:', key, Object.keys(contextData));
        return contextData[key];
    } else {
        console.log('Cache miss for:', key, Object.keys(contextData));
        return null;
    }

}

export async function saveToContext(contextName: string, data: Record<string, any>) {

    console.log('Saving to context:', contextName, Object.keys(data))
    const contextData = await loadContext(contextName);
    console.log('Old Context:', Object.keys(contextData));

    //merge the context
    const newContext = { ...contextData, ...data };
    console.log('New Context:', Object.keys(newContext));

    //compress with gzip and save
    const compressed = zlib.gzipSync(JSON.stringify(newContext));
    const file = getContextFileName(contextName);
    fs.writeFileSync(file, compressed);

    //update cache
    CONTEXT = newContext;
    console.log('Updated Context:', Object.keys(CONTEXT));


}


export function generateDocFromParts(docParts: Record<string, DocSection>): string {
    let doc = '';

    for (const sectionName of Object.keys(docParts)) {
        if (!docParts[sectionName]) continue;

        const section = docParts[sectionName];
        doc = section.content + "\n\n";

        if (section.parts) {
            for (const subPart of section.parts) {
                doc += subPart.content + "\n\n";
            }
        }


    }

    return doc;
}


export async function generateToc(client: ComposableClient, interactionName: string, envId: string, modelId: string, promptData: Partial<BasePromptData>): Promise<Toc> {


    const tocSchema = {
        "type": "object",
        "properties": {
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "slug": {
                            "type": "string",
                            "description": "The slug of the section, with no space or special characters, unique in the entire document"
                        },
                        "title": {
                            "type": "string"
                        },
                        "description": {
                            "type": "string"
                        },
                        "key_instructions": {
                            "type": "string"
                        },
                        "parts":
                        {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "slug": {
                                        "type": "string",
                                        "description": "The slug of the part, with no space or special characters, unique in the entire section"
                                    },
                                    "title": {
                                        "type": "string"
                                    },
                                    "description": {
                                        "type": "string"
                                    },
                                    "instructions": {
                                        "type": "string"
                                    }
                                },
                                "required": [
                                    "title",
                                    "description"
                                ]
                            }
                        }
                    },
                    "required": [
                        "title",
                        "description"
                    ]
                }
            }
        },
        "required": [
            "sections"
        ]
    }

    const res = await client.interactions.executeByName(interactionName, {
        data: {
            ...promptData,
            instruction: `Generate Table of Content, make sure to go through all the server side endpoints and methods.
            Make sure to introduce each endpoint objectives, the main objects used, and each endpoint ordered by importance related
            to the function of the endpoint. Write a table of content that covers the basics, and each endpoint.
            When generating the TOC, create the list of sections, and for each section, if they section is too large, you can add a list of parts.
            If the section isn't too large, you can omit the sub parts, and put all into the section.
            ${promptData.instruction ?? ''}
            `,
        },
        config: {
            environment: envId,
            model: modelId,
        },
        result_schema: tocSchema
    }).then((res) => {
        return res
    }).catch((err) => {
        console.error(err.message, err.payload?.error);
        throw new Error('Failed to generate part: ' + err.message, err);
    });

    return res.result;

}


export async function executeGeneration<T>(client: ComposableClient, interactionName: string, promptData: T, envId?: string, modelId?: string) {

    console.log(`Executing Interaction$ ${interactionName} with model ${modelId} on environment ${envId}...`);

    return client.interactions.executeByName(interactionName, {
        data: promptData,
        config: {
            environment: envId,
            model: modelId,
        }
    }).then((res) => {
        return res
    }).catch((err) => {
        console.error(err.message, err.payload?.error);
        throw new Error('Failed to generate part: ' + err.message, err);
    });

}


export function prepareFileContent(file: string) {
    const content = fs.readFileSync(file, 'utf-8');
    const filename = file.split('/').pop();
    return `\n\n========== ${filename} ========== \n\n${content}\n\n ========== End of ${filename} ==========\n\n`;
}

export function getFilesContent(files: string[], name: string): string {
    console.debug(`Reading ${files?.length ?? 0} files for ${name}`);
    if (!files || files.length === 0) {
        console.warn(`No files found for ${name}`);
        return '';
    }
    return files.map((file) => prepareFileContent(file)).join('\n');
}


export function writeTocToDisk(prefix: string, toc: Toc) {

    console.log('Writing TOC to disk', toc);
    const timestamp = new Date().toISOString();
    const dirname = prefix ?? `${timestamp}`.replace(/\//g, '_').replace(/:/g, '_');
    console.log('Writing', `${CONTENTDIR}/${dirname}`);
    fs.mkdirSync(`${CONTENTDIR}/${dirname}`, { recursive: true });

    console.log('Writing file to ', `${CONTENTDIR}/${dirname}/toc.json`);
    fs.writeFileSync(`${CONTENTDIR}/${dirname}/toc.json`, JSON.stringify(toc, null, 4));

}

export function writeSectionToDisk(prefix: string, section: DocSection, model?: string) {

    console.log('Writing section to disk', section);
    const timestamp = new Date().toISOString();

    //write json to file to backup
    fs.mkdirSync(`${CONTENTDIR}/backup`, { recursive: true });
    fs.writeFileSync(`${CONTENTDIR}/backup/${timestamp}-${section.slug}.json`, JSON.stringify(section, null, 4));

    const dirname = prefix ?? `${timestamp}`.replace(/\//g, '_').replace(/:/g, '_');
    console.log('Writing', `${CONTENTDIR}/${dirname}`);
    fs.mkdirSync(`${CONTENTDIR}/${dirname}`, { recursive: true });

    let content = `export const metadata = {
    title: '${section.title}',
    model: '${model}',
    generated_at: '${timestamp}',
    }
    \n\n
    `;
    content += section.content;
    if (section.parts) {
        for (const part of section.parts) {
            content += `\n\n${part.content}\n\n`;
        }
    }
    const dir = `${CONTENTDIR}/${dirname}/${section.slug}`;
    fs.mkdirSync(dir, { recursive: true });
    console.log('Writing file to ', `${dir}/page.mdx`);
    fs.writeFileSync(`${dir}/page.mdx`, content);

}



export interface BaseOptions {
    envId: string;
    modelId: string;
    serverApi: string[];
    clientApi: string[];
    examples: string[];
    types: string[];
    prefix: string;
    instruction: string;
    server?: string;
    token?: string;
    useContext: string;
}


export const BaseProgram = new Command()
    .option('-e, --envId <envId>', 'Environment ID in Composable')
    .option('-m, --modelId <modelId>', 'Model ID in your Environment')
    .option('--server-api <serverApi...>', 'Server Endpoints for the API')
    .option('--client-api <clientApi...>', 'code help or using the tool, typically client code')
    .option('--examples <examples...>', 'example of documentation, can be the current one')
    .option('--types <types...>', 'types and interaces used in the code')
    .option('--instruction <instruction>', 'instruction for the generation')
    .option('-s --server <apiEndpoint>', 'Server API Endpoint')
    .option('-k --token [token]', 'APIKey or JWT Token')
    .option('-C --use-context <context>', 'Use the context of the current directory', 'default')
