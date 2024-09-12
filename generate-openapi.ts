import { ComposableClient } from "@becomposable/client";
import fs from "fs";
import {
    type BaseOptions,
    BaseProgram,
    executeGeneration,
    generateDocFromParts,
    getFilesContent,
    getFromContext,
    loadContext,
    prepareContext,
    prepareFileContent,
    saveToContext,
    writeSectionToDisk,
} from ".";
import { generateToc } from "./toc";
import YAML from 'yaml';
import { OpenApiBuilder } from "openapi3-ts/oas31";

const INTERACTION_NAME = "exp:TaskGenerateOpenAPI";

interface OpenApiPromptData extends BasePromptData {
    api_endpoints: string;
    client_sdk: string;
    types: string;
}

interface GenerationOptions<T> {
    interactions: {
        toc: string;
        content: string;
    };

    generation: {
        modelId: string;
        envId: string;
    };

    context: string;

    params: T;
}

async function generate(client: ComposableClient, options: OpenApiOptions) {
    console.log("Generating Doc with options:", options);
    await prepareContext(options);

    console.log(`Context ${options.useContext} is now ready`);
    const { modelId, envId } = options;

    //generate table of content for path
    let pathToc = (await getFromContext(options.useContext, "toc")) as
        | openapiPathToc
        | undefined;
    if (!pathToc) {
        console.log("Generating Table of Content...");
        const context = await loadContext(options.useContext);
        pathToc = await generateToc<openapiPathToc>(
            client,
            INTERACTION_NAME,
            envId,
            modelId,
            {
                ...context,
                instruction: `Generate the Table of Content for the OpenAPI Documentation.
            Each section should be a path in the OpenAPI spec.
            The next step will be to generate the documentation for each path.
            Group path by tags, representing resources. When generating a path, you mush generate the path and its types, if the types are not
            already present.`,
            },
            openApiTocSchema,
        );
        if (!pathToc) {
            throw new Error("Failed to generate Table of Content");
        }
        console.log(`ToC Generated - (${pathToc.paths.length}) sections`, { toc: pathToc });
        saveToContext(options.useContext, { toc: pathToc });
    } else {
        console.log(`ToC already generated - (${pathToc.paths.length}) sections`, {
            toc: pathToc,
        });
    }

    const sectionIds = [];

    for (const path of pathToc.paths) {
        const res = await generatePath(client, path, options);
        sectionIds.push(path.id);
    }


    let typesToc = (await getFromContext(options.useContext, "typesToc")) as
        | openApiTypeToc
        | undefined;
    if (!typesToc) {
        console.log("Generating Table of Types...");
        const context = await loadContext(options.useContext);
        typesToc = await generateToc<openApiTypeToc>(
            client,
            INTERACTION_NAME,
            envId,
            modelId,
            {
                ...context,
                instruction: `Generate the Table of Content for the OpenAPI Documentation.
            Each section should be a type in the OpenAPI spec, used by the paths already generated.
            The next step will be to generate the type definition for each type`,
            },
            openApiTypeTocSchema,
        );
        if (!typesToc) {
            throw new Error("Failed to generate Table of Content");
        }
        console.log(`ToC Generated - (${typesToc.types.length}) items`, { toc: typesToc });
        saveToContext(options.useContext, { typesToc: typesToc });
    } else {
        console.log(`ToC already generated - (${pathToc.paths.length}) items`, {
            toc: typesToc,
        });
    }

    for (const typeName of typesToc.types) {
        const res = await generateType(client, typeName, options);
    }

    //putting it all together
    const builder = new OpenApiBuilder();
    for (const pathId of sectionIds) {
        const path = await getFromContext(options.useContext, pathId);
        builder.addPath(pathId, path[pathId]);
    }

    for (const typeName of typesToc.types) {
        const type = await getFromContext(options.useContext, typeName);
        builder.addSchema(typeName, type[typeName]);
    }

    builder.addInfo({
        title: options.title ?? "OpenAPI Spec",
        version: options.version ?? "1.0.0",
    });
    if (options.openapiServer) {
        builder.addServer({
            url: options.openapiServer
        });
    }

    builder.addSecurityScheme("bearer", {
        type: "openIdConnect",
        bearerFormat: "JWT",
        scheme: "bearer",
    })

    const doc = builder.getSpecAsYaml()
    fs.writeFileSync("openapi-spec.yaml", doc)

}

interface BasePromptData {
    already_generated: string;
    part_name: string;
    instruction: string;
    [k]: any;
}

async function generateType(client: ComposableClient, typeName: string, options: BaseOptions) {

    console.log("Generating type", typeName)
    const existing = await getFromContext(options.useContext, typeName);
    if (existing) {
        console.log("Type already generated", typeName);
        return existing;
    }

    const { context, alreadyGenerated } = await getAlreadyGenerated(options);
    const { modelId, envId } = options;
    const promptData = {
        ...context,
        already_generated: JSON.stringify(alreadyGenerated),
        part_name: typeName,
        instruction: `Generate the type: ${typeName}. This will be included in the components/schema section of the OpenAPI spec.`,
    };
    const res = await executeGeneration<BasePromptData>(
        client,
        INTERACTION_NAME,
        promptData,
        envId,
        modelId,
    );

    console.log("Type generated", typeName, res.result)
    saveToContext(options.useContext, { [typeName]: res.result });

    return res.result;


}

async function getAlreadyGenerated(options: BaseOptions) {

    const context = await loadContext(options.useContext);
    const alreadyGenerated = Object.keys(context)
        .filter((k) => k.startsWith("g-"))
        .map((k) => context[k]);
    const contextForPrompt = { ...context };
    for (const k of Object.keys(context).filter((k) => k.startsWith("g-"))) {
        delete contextForPrompt[k];
    }

    return { context: contextForPrompt, alreadyGenerated };

}

async function generatePath(
    client: ComposableClient,
    path: pathSection,
    options: BaseOptions,
) {
    const existing = await getFromContext(options.useContext, path.id);
    if (existing) {
        console.log("Section already generated", path.id);
        return existing;
    }

    const { context, alreadyGenerated } = await getAlreadyGenerated(options);

    const promptData = {
        ...context,
        already_generated: JSON.stringify(alreadyGenerated),
        part_name: path.id,
        instruction: `Generate the path: ${path.id}. Include everything required for this path: methods, errors, types, etc.`,
    };

    const { modelId, envId } = options;
    const res = await executeGeneration<BasePromptData>(
        client,
        INTERACTION_NAME,
        promptData,
        envId,
        modelId,
    );


    const result = validateYaml(res.result)
    saveToContext(options.useContext, { [path.id]: result });
    console.log("Section generated and saved to context", path.id, result);

    return path;

}

function validateYaml(text: string) {
    const generatedPart = removeCodeBlockMarkers(text)
    try {
        YAML.parse(generatedPart);
    } catch (e) {
        console.log("Failed to parse generated part", generatedPart);
        throw e;
    }
    return generatedPart;
}

function removeCodeBlockMarkers(text: string) {
    return text.replace(/```[\w-]*\n/g, "").replace(/```/g, "");
}

//use commander to get envId and modelId
const openapiGenerator = BaseProgram.action((options: BaseOptions) => {
    if (!options.server) {
        throw new Error("Server URL is required");
    }

    const client = new ComposableClient({
        apikey: options.token,
        serverUrl: options.server,
        storeUrl: options.server,
    });
    console.log(`Generating Doc for ${options.useContext}...`);

    generate(client, options);
});


openapiGenerator.option("-T, --title [title]", "Title of the OpenAPI spec");
openapiGenerator.option("-V, --version [version]", "Version of the OpenAPI spec");
openapiGenerator.option("-S, --openapi-server [server]", "Server URL");
openapiGenerator.parse(process.argv);

interface OpenApiOptions extends BaseOptions {
    title?: string;
    version?: string;
    openapiServer?: string;
}

interface pathSection {
    id: string;
    operation: "create" | "update" | "delete";
    name: string;
    description: string;
}

interface openapiPathToc {
    paths: pathSection[];
}

interface openApiTypeToc {
    types: string[];
}


const openApiTocSchema = {
    type: "object",
    properties: {
        paths: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string",
                        description: "the API path to generate",
                    },
                    operation: {
                        type: "string",
                        enum: ["create", "update", "delete"],
                        description:
                            "The operation to perform on the section, create, update or delete. If update, you will be requested later to provide the list of change operation to perform.",
                    },
                    name: {
                        type: "string",
                        description:
                            "The name or title of the section, should be the path in the OpenAPI spec, of the title of the section/part.",
                    },
                    description: {
                        type: "string",
                    },
                },
                required: ["id", "name", "operation"],
            },
        },
        types: {
            type: "array",
            items: {
                type: "string",
                description: "The name of the type to generate",
            },
        },
    },
    required: ["paths"],
};

const openApiTypeTocSchema = {
    type: "object",
    properties: {
        types: {
            type: "array",
            items: {
                type: "string",
                description: "The name of the type to generate",
            },
        },
    },
    required: ["types"],
};
