import { ComposableClient } from '@becomposable/client';
import { Command } from 'commander';
import fs from 'fs';
import { glob } from 'glob';
import zlib from 'zlib';
import type { Toc } from './toc';

const CPBASE = process.env.CPBASE || '.';
const CONTENTDIR = `${CPBASE}/content`;
const CONTEXTDIR = `${CPBASE}/context`;
let CONTEXT: Record<string, any> | undefined = undefined;

export interface BasePromptData {
    instruction?: string;
    previously_generated?: string;
    toc?: Toc;
    part_name: string;
}

export interface DocSection {
    id: string;
    name: string;
    content: string;
    parts?: DocPart[];
}

export interface DocPart {
    id: string;
    name: string;
    content: string;
}


function getContextFileName(name: string) {
    return `${CONTEXTDIR}/${name}.json.gz`;
}

export async function loadContext(name: string): Promise<Record<string, any>> {
    if (CONTEXT) return CONTEXT;

    const contextPath = getContextFileName(name);
    if (fs.existsSync(contextPath)) {
        const data = zlib.gunzipSync(fs.readFileSync(contextPath));
        const contextData = JSON.parse(data.toString());
        CONTEXT = contextData;
        console.log('Loaded Context:', Object.keys(contextData));
        return Promise.resolve(contextData);
    } else {
        return {};
    }
}


export async function getFromContext(contextName: string, key: string) {
    const contextData = await loadContext(contextName);

    if (contextData[key]) {
        return contextData[key];
    } else {
        return null;
    }

}

export async function saveToContext(contextName: string, data: Record<string, any>) {

    console.log('Saving to context:', contextName, Object.keys(data))
    const contextData = await loadContext(contextName);

    //merge the context
    const newContext = { ...contextData, ...data };

    //compress with gzip and save
    const compressed = zlib.gzipSync(JSON.stringify(newContext));
    const file = getContextFileName(contextName);
    fs.writeFileSync(file, compressed);

    //update cache
    CONTEXT = { ...newContext };
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

export function getFilesContent(files: string[]): string {
    if (!files || files.length === 0) {
        console.warn(`No files found`);
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


export async function getFiles(options: BaseOptions): Promise<Record<string, string[]>> {

    if (!options.files || !options.files.length) {
        throw new Error('No files specified');
    }

    const filesByKey: Record<string, string[]> = {};
    for (let filesSpec of options.files) {
        const [key, spec] = filesSpec.split(':');
        console.log('Listing files for', key, spec)
        if (!key || !glob) {
            throw new Error('Invalid file spec: ' + filesSpec);
        }
        const files = await glob(spec);

        if (!files) {
            console.log('No files found for spec: ', filesSpec);
            continue;
        }
        if (!filesByKey[key]) {
            filesByKey[key] = files;
        } else {
            filesByKey[key] = [...filesByKey[key], ...files];
        }
    }

    return filesByKey;

}

//load the files into the context
export async function prepareContext(options: BaseOptions) {
    console.log('Preparing context...')
    const specsByKey = await getFiles(options);

    for (const key of Object.keys(specsByKey)) {
        console.log('Loading files into context key', key);
        const files = specsByKey[key];
        const content = getFilesContent(files)

        await saveToContext(options.useContext, { [key]: content });
        console.log(`Loaded ${files.length} files into ${key} for (${(content.length / 1000).toFixed(2)}kB)`)
    }

    const data: Record<string, string> = {}
    for (const item of options.data ?? []) {
        const [key, value] = item.split(':');
        console.log('Setting data', key, value);
        data[key] = value;
    }
    await saveToContext(options.useContext, data)


}

async function generate(client: ComposableClient, options: BaseOptions) {

    console.log('Generating Doc with options:', options);
    if (!options.interaction) {
        throw new Error('No interaction provided');
    }

    await prepareContext(options);

    const promptData = await loadContext(options.useContext) ?? {};
    console.log('Prompt Keys:', Object.keys(promptData))

    const res = await executeGeneration(client, options.interaction, promptData, options.envId, options.modelId);

    if (options.output) {
        console.log('Writing output to', options.output)
        if (typeof res.result === 'object') {
            fs.writeFileSync(options.output, JSON.stringify(res.result, null, 4));
        } else {
            fs.writeFileSync(options.output, res.result);
        }
    }

    return res.result;

}

export interface BaseOptions {
    envId: string;
    modelId: string;
    files: string[];
    instruction: string;
    server?: string;
    token?: string;
    useContext: string;
    interaction?: string;
    output?: string;
    data?: string[];
}


export const BaseProgram = new Command()
    .option('-e, --envId <envId>', 'Environment ID in Composable')
    .option('-m, --modelId <modelId>', 'Model ID in your Environment')
    .option('-s --server <apiEndpoint>', 'Composable API Server')
    .option('-k --token <token>', 'APIKey or JWT Token')
    .option('-C --use-context <context>', 'Use the context of the current directory', 'default')
    .option('-f, --files <key:glob...>', 'Pass files to be included in context, under the key passed')
    .option('-d, --data <key:value...>', 'Data to pass to the interaction in format key:value')
    .option('-I, --instruction <instruction>', 'Instruction for the generation')
    .option('-i, --interaction [interaction]', 'Interaction to execute')
    .option('-o, --output [filename|directory]', 'Where to save the result, directory or file')


const generator = BaseProgram
    .action((options: BaseOptions) => {

        if (!options.server) {
            throw new Error('No server provided');
        }

        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.server,
            storeUrl: options.server.replace('studio', 'store')
        });
        console.log(`Generating Doc for ${options.useContext}...`);

        generate(client, options);
    });

generator.parse(process.argv);
