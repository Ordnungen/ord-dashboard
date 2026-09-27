import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// Read minAppVersion from manifest.json and bump version to the target version.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 4));

// versions.json maps a plugin version to the minimum Obsidian version it needs.
// Per the Obsidian documentation it only has to be updated when minAppVersion
// changes, so we skip the entry while minAppVersion stays the same.
// Keys are kept in ascending order to stay readable.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const minAppVersions = Object.values(versions);
const lastMinAppVersion = minAppVersions[minAppVersions.length - 1];
if (!(targetVersion in versions) && lastMinAppVersion !== minAppVersion) {
    versions[targetVersion] = minAppVersion;
    writeFileSync("versions.json", JSON.stringify(versions, null, 4));
}
