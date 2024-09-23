/**
* Simple, one pass, generator. Typically useful for generating a single document or file, using source
* code or documentation as input.
* Typically useful for release notes, release highlights, etc.
*/

import { ComposableClient } from "@becomposable/client";
import { BaseProgram, generate, type BaseOptions } from ".";




const generator = BaseProgram
    .action((options: BaseOptions) => {

        if (!options.server) {
            throw new Error('No server provided');
        }

        const client = new ComposableClient({
            apikey: options.token,
            serverUrl: options.server ?? "https://studio-server-preview.api.becomposable.com",
            storeUrl: options.server.replace('studio', 'store')
        });
        console.log(`Generating Doc for ${options.useContext}...`);

        generate(client, options);
    });

generator.parse(process.argv);
