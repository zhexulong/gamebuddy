import { publishEquipToolReleaseBundle } from "./release-bundle-publisher.mjs";

function parse(argv) {
  if (argv.length !== 4 || argv[0] !== "--source" || argv[2] !== "--destination") throw new Error("stardew_release_bundle_publish_usage");
  return { sourceDir: argv[1], destinationDir: argv[3] };
}

try {
  const receipt = await publishEquipToolReleaseBundle(parse(process.argv.slice(2)));
  process.stdout.write(JSON.stringify(receipt));
} catch (error) {
  process.stderr.write(`${error?.message || "stardew_release_bundle_publish_failed"}\n`);
  process.exitCode = 1;
}
