import type { ComposableClient } from "@becomposable/client";
import type { BasePromptData } from ".";

export interface Toc {
    sections: {
        id: string;
        name: string;
        description: string;
        instructions?: string;
        parts?: {
            id: string;
            name: string;
            description: string;
            instructions?: string;
        }[]
    }[]
}


const defaultTocSchema = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "the id of the section, can be a filename if working on a file, a slug if working on a document or path, or a unique identifier if working on a model."
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
                    },
                    "key_instructions": {
                        "type": "string"
                    },
                    "parts":
                    {
                        "type": "array",
                        "description": "when the section is too large, you can split it into parts, each part should have a title and description. Use it to split the section into subsection. When doing an API documentation, you can do one part for each path. When generating code, you can do one part for each method. When generating an OpenAPI spec, you can do one part for each operation.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {
                                    "type": "string",
                                    "description": "the id of the part, can be a filename if working on a file, a slug if working on a document or path, or a unique identifier if working on a model."
                                },
                                "name": {
                                    "type": "string",
                                    "description": "The name or title of the part, should be the path in the OpenAPI spec, of the title of the section/part."
                                },
                                "description": {
                                    "type": "string"
                                },
                                "instructions": {
                                    "type": "string"
                                }
                            },
                            "required": [
                                "id",
                                "name",
                            ]
                        }
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
        "sections"
    ]
}



export async function generateToc<T>(client: ComposableClient, interactionName: string, envId: string, modelId: string, promptData: Partial<BasePromptData>, tocSchema?: any): Promise<T> {
    const res = await client.interactions.executeByName(interactionName, {
        data: {
            ...promptData,
            instruction: `Generate Table of Content or Operations, make sure to go through all the server side endpoints and methods.
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
        result_schema: tocSchema ?? defaultTocSchema
    }).then((res) => {
        return res
    }).catch((err) => {
        console.error(err.message, err.payload?.error);
        throw new Error('Failed to generate part: ' + err.message, err);
    });

    return res.result;
}
