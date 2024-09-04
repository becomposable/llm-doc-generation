import { ComposableClient } from "@becomposable/client";
import { BaseProgram, getFiles, loadContext, saveToContext, type BaseOptions } from ".";
import fs from 'fs';

function chunkArray<T>(arr: T[], chunkSize: number): T[][] {
    console.log('Chunking array of length', arr.length, 'into chunks of size', chunkSize);
    const chunks = [];
    for (let i = 0; i < arr.length; i += chunkSize) {
        chunks.push(arr.slice(i, i + chunkSize));
    }
    console.log('Created', chunks.length, 'chunks');
    console.log('Last chunk size:', chunks[chunks.length - 1].length);
    return chunks;
}


async function generate(client: ComposableClient, options: BaseOptions) {

    const filesByKey = await getFiles(options);

    //for each section generate code summary map
    for (const key of Object.keys(filesByKey)) {
        console.log('Processing', key);
        const context = await loadContext(options.useContext);
        const filesToProcess = filesByKey[key].filter(f => !context[f])
        console.log('Processing', filesToProcess.length, 'files for', key);

        const slices = chunkArray(filesToProcess, 50);
        for (const slice of slices) {
            const promises = slice.map(async (file) => {
                const code = fs.readFileSync(file, 'utf-8');
                console.log('Processing', file);
                return client.interactions.executeByName("JavaCodeSummaryGenerator", {
                    data: {
                        code
                    }
                }).then(res => {
                    console.log('Saving summary for', file, res.result);
                    saveToContext(options.useContext, {
                        [file]: res.result
                    })
                }).catch(err => {
                    console.error('Error processing -- skipping', file, err);
                });
            });
            await Promise.all(promises);
        }
    }

    console.log('Done');
    const state = await loadContext(options.useContext);

    if (options.output) {
        fs.writeFileSync(options.output, JSON.stringify(state, null, 2));
    } else {
        console.log(state)
    }

}



//use commander to get envId and modelId
const summaryMapGenerator = BaseProgram
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

summaryMapGenerator.parse(process.argv);
