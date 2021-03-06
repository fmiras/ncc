const { resolve, relative, dirname, sep } = require("path");
const execa = require('execa')
const glob = require("glob");
const rimraf = require("rimraf");
const crypto = require("crypto");
const fs = require("fs");
const mkdirp = require("mkdirp");

const shebangRegEx = require("./utils/shebang");
const { stat } = require("./utils/filesystem")

const usage = `Usage: ncc <cmd> <opts>

Commands:
  build <input-file> [opts]
  run <input-file> [opts]
  cache clean|dir|size
  help
  version

Options:
  -o, --out [file]      Output directory for build (defaults to dist)
  -m, --minify          Minify output
  -C, --no-cache        Skip build cache population
  -s, --source-map      Generate source map
  -e, --external [mod]  Skip bundling 'mod'. Can be used many times
  -q, --quiet           Disable build summaries / non-error outputs
  -q, --watch           Start a watched build
  -D, --no-dep-install   Disable autoinstall dependencies feature
`;

let args;

try {
  args = require("arg")({
    "--external": [String],
    "-e": "--external",
    "--out": String,
    "-o": "--out",
    "--minify": Boolean,
    "-m": "--minify",
    "--source-map": Boolean,
    "-s": "--source-map",
    "--no-cache": Boolean,
    "-C": "--no-cache",
    "--quiet": Boolean,
    "-q": "--quiet",
    "--watch": Boolean,
    "-w": "--watch",
    "--no-dep-install": Boolean,
    "-D": "--no-dep-install"
  });
} catch (e) {
  if (e.message.indexOf("Unknown or unexpected option") === -1) throw e;
  console.error(e.message + `\n${usage}`);
  process.exit(1);
}

function renderSummary(code, assets, outDir, buildTime) {
  if (outDir && !outDir.endsWith(sep)) outDir += sep;
  const codeSize = Math.round(Buffer.byteLength(code, "utf8") / 1024);
  const assetSizes = Object.create(null);
  let totalSize = codeSize;
  let maxAssetNameLength = 8; // "index.js".length
  for (const asset of Object.keys(assets)) {
    const assetSource = assets[asset];
    const assetSize = Math.round(
      (assetSource.byteLength || Buffer.byteLength(assetSource, "utf8")) / 1024
    );
    assetSizes[asset] = assetSize;
    totalSize += assetSize;
    if (asset.length > maxAssetNameLength) maxAssetNameLength = asset.length;
  }
  const orderedAssets = Object.keys(assets).sort((a, b) =>
    assetSizes[a] > assetSizes[b] ? 1 : -1
  );

  const sizePadding = totalSize.toString().length;

  let indexRender = `${codeSize
    .toString()
    .padStart(sizePadding, " ")}kB  ${outDir}${"index.js"}`;

  let output = "",
    first = true;
  for (const asset of orderedAssets) {
    if (first) first = false;
    else output += "\n";
    if (codeSize < assetSizes[asset] && indexRender) {
      output += indexRender + "\n";
      indexRender = null;
    }
    output += `${assetSizes[asset]
      .toString()
      .padStart(sizePadding, " ")}kB  ${outDir}${asset}`;
  }

  if (indexRender) output += (first ? "" : "\n") + indexRender;

  output += `\n${totalSize}kB  [${buildTime}ms]`;

  return output;
}

if (args._.length === 0) {
  console.error(`Error: No command specified\n${usage}`);
  process.exit(1);
}

let run = false;
let outDir = args["--out"];

switch (args._[0]) {
  case "cache":
    if (args._.length > 2)
      errTooManyArguments("cache");

    const flags = Object.keys(args).filter(arg => arg.startsWith("--"));
    if (flags.length)
      errFlagNotCompatible(flags[0], "cache");

    const cacheDir = require("./utils/ncc-cache-dir");
    switch (args._[1]) {
      case "clean":
        rimraf.sync(cacheDir);
      break;
      case "dir":
        console.log(cacheDir);
      break;
      case "size":
        require("get-folder-size")(cacheDir, (err, size) => {
          if (err) {
            if (err.code === 'ENOENT') {
              console.log("0MB");
              return;
            }
            throw err;
          }
          console.log(`${(size / 1024 / 1024).toFixed(2)}MB`);
        });
      break;
      default:
        errInvalidCommand("cache " + args._[1]);
    }

  break;
  case "run":
    if (args._.length > 2)
      errTooManyArguments("run");

    if (args["--out"])
      errFlagNotCompatible("--out", "run");

    outDir = resolve(
      require("os").tmpdir(),
      crypto.createHash('md5').digest(resolve(args._[1] || ".")).toString('hex')
    );
    if (fs.existsSync(outDir)) {
      console.error(
        `Error: Application at ${args._[1] || "."} is already running or didn't cleanup after previous run.` +
        `To manually clear the last run build, try running "rm -rf ${outDir}".`
      );
      process.exit(1);
    }
    run = true;

  // fallthrough
  case "build":
    if (args._.length > 2)
      errTooManyArguments("build");

    let startTime = Date.now();
    let ps;
    const ncc = require("./index.js")(
      eval("require.resolve")(resolve(args._[1] || ".")),
      {
        minify: args["--minify"],
        externals: args["--external"],
        sourceMap: args["--source-map"] || run && args["--minify"],
        cacheDirectory: args["--no-cache"] ? false : undefined,
        watch: args["--watch"]
      }
    );

    async function handler ({ err, code, map, assets }) {
      if (!args["--no-dep-install"]) {
        await installDependencies()
      }

      // handle watch errors
      if (err) {
        console.error(err);
        console.log('Watching for changes...');
        return;
      }

      outDir = outDir || resolve("dist");
      mkdirp.sync(outDir);
      // remove all existing ".js" files in the out directory
      await Promise.all(
        (await new Promise((resolve, reject) =>
          glob(outDir + '/**/*.js', (err, files) => err ? reject(err) : resolve(files))
        )).map(file =>
          new Promise((resolve, reject) => fs.unlink(file, err => err ? reject(err) : resolve())
        ))
      );
      fs.writeFileSync(outDir + "/index.js", code, { mode: code.match(shebangRegEx) ? 0o777 : 0o666 });
      if (map) fs.writeFileSync(outDir + "/index.js.map", map);

      for (const asset of Object.keys(assets)) {
        const assetPath = outDir + "/" + asset;
        mkdirp.sync(dirname(assetPath));
        fs.writeFileSync(assetPath, assets[asset]);
      }

      if (!args["--quiet"]) {
        console.log( 
          renderSummary(
            code,
            assets,
            run ? "" : relative(process.cwd(), outDir),
            Date.now() - startTime,
          )
        );

        if (args["--watch"])
          console.log('Watching for changes...');
      }

      if (run) {
        ps = require("child_process").fork(outDir + "/index.js", {
          execArgv: map
            ? ["-r", resolve(__dirname, "sourcemap-register")]
            : []
        });
        ps.on("close", () => require("rimraf").sync(outDir));
      }
    }
    if (args["--watch"]) {
      ncc.handler(handler);
      ncc.rebuild(() => {
        if (ps)
          ps.kill();
        startTime = Date.now();
        console.log('File change, rebuilding...');
      });
    } else {
      ncc.then(handler)
      .catch(err => {
        console.error(err.stack);
        process.exit(1);
      });
    }
    break;

  case "help":
    console.error(usage);
    process.exit(2);

  case "version":
    console.log(require("../package.json").version);
    break;

  default:
    errInvalidCommand(args._[0]);
}

function errTooManyArguments (cmd) {
  console.error(`Error: Too many ${cmd} arguments provided\n${usage}`);
  process.exit(1);
}

function errFlagNotCompatible (flag, cmd) {
  console.error(`Error: ${flag} flag is not compatible with ncc ${cmd}\n${usage}`);
  process.exit(1);
}

function errInvalidCommand (cmd) {
  console.error(`Error: Invalid command "${cmd}"\n${usage}`);
  process.exit(1);
}

// remove me when node.js makes this the default behavior
process.on("unhandledRejection", e => {
  throw e;
});

async function installDependencies() {
  const [hasPackageJson, hasNodeModules, hasYarnLock] = await Promise.all([
    stat(resolve(process.cwd(), "package.json")),
    stat(resolve(process.cwd(), "node_modules")),
    stat(resolve(process.cwd(), "yarn.lock"))
  ])
  if (hasPackageJson && !hasNodeModules) {
    if(hasYarnLock) {
      await execa("yarn", { stdout: process.stdout, stderr: process.stderr })  
    } else{
      const npm = /^win/.test(process.platform) ? "npm.cmd" : "npm"
      await execa(npm, ["install"], { stdout: process.stdout, stderr: process.stderr })
    }
  }
}

