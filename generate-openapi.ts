import { ComposableClient } from '@becomposable/client';
import fs from 'fs';
import { type BaseOptions, BaseProgram, type BasePromptData, type DocPart, type DocSection, executeGeneration, generateDocFromParts, getFilesContent, getFromContext, loadContext, prepareFileContent, saveToContext, type Toc } from '.';
import { glob } from 'glob';
import { generateToc } from './toc';

const INTERACTION_NAME = "exp:TaskGenerateOpenAPI"


interface OpenApiPromptData extends BasePromptData {
    api_endpoints: string;
    client_sdk: string;
    types: string;
}

interface GenerationOptions<T> {

    interactions: {
        toc: string;
        content: string;
    }

    generation: {
        modelId: string
        envId: string
    }

    context: string;

    params: T;

}




async function generate(client: ComposableClient, options: BaseOptions) {
    console.log('Generating Doc with options:', options);
    await prepareContext(options);

    console.log(`Context ${options.useContext} is now ready`)
    const { modelId, envId } = options;


    //generate table of content
    let toc = await getFromContext(options.useContext, 'toc') as openapiToc | undefined;
    if (!toc) {
        console.log('Generating Table of Content...');
        const context = await loadContext(options.useContext);
        toc = await generateToc<openapiToc>(client, INTERACTION_NAME, envId, modelId, {
            ...context,
            instruction: `Generate the Table of Content for the OpenAPI Documentation.
            Each section should be a path in the OpenAPI spec.
            The next step will be to generate the documentation for each path.
            Group path by tags, representing resources. When generating a path, you mush generate the path and its types, if the types are not
            already present.`
        }, openApiTocSchema)
        if (!toc) {
            throw new Error('Failed to generate Table of Content');
        }
        console.log(`ToC Generated - (${toc.paths.length}) sections`, { toc })
        saveToContext(options.useContext, { toc });
    } else {
        console.log(`ToC already generated - (${toc.paths.length}) sections`, { toc })
    }

    for (const path of toc.paths) {
        const res = await generatePath(client, path, options);
    }


}

interface BasePromptData {
    already_generated: string;
    part_name: string;
    instruction: string;
    [k]: any;
}

async function generatePath(client: ComposableClient, path: pathSection, options: BaseOptions) {

    const existing = await getFromContext(options.useContext, path.id);
    if (existing) {
        console.log('Section already generated', path.id);
        return existing;
    }

    const context = await loadContext(options.useContext);
    const alreadyGenerated = Object.keys(context).filter(k => k.startsWith("g-")).map(k => context[k]);
    const contextForPrompt = { ...context }
    for (const k of Object.keys(context).filter(k => k.startsWith("g-"))) {
        delete contextForPrompt[k];
    }

    const promptData = {
        ...context,
        already_generated: JSON.stringify(alreadyGenerated),
        part_name: path.id,
        instruction: `Generate the section: ${path.id}. Include everything required for this path: methods, errors, types, etc.`,
    }

    const { modelId, envId } = options;
    const res = await executeGeneration<BasePromptData>(client, INTERACTION_NAME, promptData, envId, modelId);

    saveToContext(options.useContext, { [path.id]: res.result });
    console.log('Section generated and saved to context', path.id, res.result);

}


//use commander to get envId and modelId
const openapiGenerator = BaseProgram
    .action((options: BaseOptions) => {

        if (!options.server) {
            throw new Error('Server URL is required');
        }

        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.server,
            storeUrl: options.server,
        });
        console.log(`Generating Doc for ${options.useContext}...`);




        generate(client, options);
    });

openapiGenerator.parse(process.argv);


interface pathSection {
    id: string;
    operation: 'create' | 'update' | 'delete';
    name: string;
    description: string;
}

interface openapiToc {
    paths: pathSection[];
}


const openApiTocSchema = {
    "type": "object",
    "properties": {
        "paths": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "the API path to generate"
                    },
                    "operation": {
                        "type": "string",
                        "enum": ["create", "update", "delete"],
                        "description": "The operation to perform on the section, create, update or delete. If update, you will be requested later to provide the list of change operation to perform."
                    },
                    "name": {
                        "type": "string",
                        "description": "The name or title of the section, should be the path in the OpenAPI spec, of the title of the section/part."
                    },
                    "description": {
                        "type": "string"
                    }
                },
                "required": [
                    "id",
                    "name",
                    "operation"
                ]
            }
        }
    },
    "required": [
        "paths"
    ]
}
