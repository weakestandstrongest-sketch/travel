import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { planTrip } from "./core/planner.js";
import { refineWithTransit } from "./core/transit.js";
import { toIcs } from "./export/ics.js";
import { toMarkdown } from "./export/markdown.js";
import { NominatimGeocoder, resolveCoordinates, type TripInput } from "./providers/geocoder.js";
import { NorikaeProvider } from "./providers/norikae.js";

const USAGE = `使い方: npm run plan -- <旅行ファイル.json> [--format md|ics|json] [--out 出力先] [--norikae のりかえのURL]`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      format: { type: "string", default: "md" },
      out: { type: "string" },
      norikae: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const file = positionals[0];
  if (values.help || !file) {
    console.log(USAGE);
    process.exitCode = file ? 0 : 1;
    return;
  }

  const input = JSON.parse(await readFile(file, "utf8")) as TripInput;
  const geocoder = new NominatimGeocoder({
    userAgent: process.env.GEOCODER_USER_AGENT ?? "travel-planner/0.1 (https://github.com/weakestandstrongest-sketch/travel)",
  });
  const request = await resolveCoordinates(input, geocoder);
  let itinerary = planTrip(request);
  const norikaeUrl = values.norikae;
  if (norikaeUrl) {
    itinerary = await refineWithTransit(itinerary, new NorikaeProvider(norikaeUrl), {
      onProgress: (done, total) => console.error(`のりかえで電車を調べています… ${done}/${total}`),
    });
  }

  let output: string;
  switch (values.format) {
    case "md":
      output = toMarkdown(itinerary, { norikaeUrl });
      break;
    case "ics":
      output = toIcs(itinerary, { norikaeUrl });
      break;
    case "json":
      output = JSON.stringify(itinerary, null, 2) + "\n";
      break;
    default:
      throw new Error(`未対応の形式です: ${values.format}\n${USAGE}`);
  }

  if (values.out) {
    await writeFile(values.out, output);
    console.error(`${values.out} に書き出しました`);
  } else {
    process.stdout.write(output);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
