require('6to5/polyfill');
let through = require('through2');
let detective = require('detective');
let combine = require('stream-combiner');
let path = require('path');
let {
	binder,
	invoke,
	not,
	maskFilter,
	catcher,
	uniqFilter,
	values,
	getter
} = require('./f');
let async = require('async');
let fs = require('fs');
let vinylFs = require('vinyl-fs');
let dependencyResolver = require('./dependencyResolver');
let VinylFile = require('vinyl');
let StreamConcat = require('stream-concat');
let beautify = require('js-beautify');
let bundleSerializer = require('./bundleSerializer');
let countDownLatch = require('./countDownLatch');
let UnresolvedDependenciesError = require('./errors/UnresolvedDependenciesError');

let transformers = {
	/**
	 * Wraps a vinyl stream in an object.
	 *
	 * The goal of this is to be able to pass additional data alongside the vinyl stream without
	 * having to monkey patch the vinyl objects.
	 */
	wrapVinyl () {
		return through.obj((chunk, enc, done) => {
			done(null, {
				vinyl : chunk
			});
		});
	},

	/**
	 * Finds and attaches dependencies of a file
	 */
	findDependencies (instance) {
		return through.obj((chunk, enc, done) => {
			chunk.deps = {};
			detective(chunk.vinyl.contents.toString())
				//For now all dependencies will have value null since they're not resolved yet
				.forEach((dep) => chunk.deps[dep] = null );
			done(null, chunk);
		});
	},

	/**
	 * Resolves dependencies and adds them to the stream
	 */
	resolveDependencies (instance) {
		return through.obj(function resolveDependencies(chunk, enc, done) {
			//Push the current file, we'll need that anyway
			let onSuccess = catcher(done);

			let deps = Object.keys(chunk.deps);

			async.map(deps, dependencyResolver(chunk, instance), onSuccess((resolvedDeps) => {
				//Check if we've found all dependencies:
				//At this point resolvedDeps should be an array of {file, base} pairs, but any dependency that could
				//not be resolved will have falsy values for the file values. We use that to filter out
				//unresolved dependencies.
				let unresolvedMask = resolvedDeps.map(getter('file')).map(not);
				let unresolved = deps.filter(maskFilter(unresolvedMask));
				if (unresolved.length) {
					return done(new UnresolvedDependenciesError(chunk.vinyl.path, unresolved));
				}

				//Now we can attach the dependency objects to the chunk.deps object.
				resolvedDeps.forEach((dep, index) => {
					let depName = deps[index];
					chunk.deps[depName] = dep;
				});

				done(null, chunk);
			}));
		});
	},

	compileDependencies (instance, compile) {
		return through.obj(function (chunk, enc, done) {

			let outer = this;
			//We don't want to compile the same file twice, so we remove those that we've seen already
			//here, and additionally we update the filesSeen list
			let newFiles = values(chunk.deps)
				.filter((dep) => instance.filesSeen.indexOf(dep.file) === -1);
			instance.filesSeen.concat(newFiles.map((file) => file.path));

			//Note: we can only push the chunk when we're done with it's properties: as soon as the chunk
			//is pushed it will be piped trough the rest of the pipeline, which might alter the object.
			this.push(chunk);
			let latch = countDownLatch(newFiles.length, () =>  done());
			newFiles.forEach((file) => {
				compile(file.file, file.base)
					.pipe(through.obj(function(chunk, enc, cb) {
						outer.push(chunk);
						cb(null, chunk);
						//this currently assumes that each stream has exactly one file, and should be improved
						//Unfortunatally it somehow didn't work when the countDown call was done in the flush
						//function, the flush function was just never called.
						latch.countDown();
					}));
			});
		});
	},

	/**
	 * Resolves the require paths to links to actual files in the bundle.
	 */
	linkDependencies (instance) {
		return through.obj(function (chunk, enc, done) {
			Object.keys(chunk.deps)
				.forEach((depName) =>  {
					let dep = chunk.deps[depName];
					//If the dependency is in the same module as the file that requires it we can just
					//use a relative require. Otherwise we'll have to try a path-require or an external require
					if (dep.file.startsWith(chunk.vinyl.base)) {
						chunk.deps[depName] = './' + path.relative(path.dirname(chunk.vinyl.path), dep.file);
					} else {
						let pathEntry = instance.options.path.find((pathEntry) => {
							return chunk.vinyl.path.startsWith(pathEntry.path);
						});
						if (!pathEntry) {
							throw new Error("Could not find the base module for " + chunk.vinyl.path);
						}
						chunk.deps[depName] = pathEntry.name + '/' + path.relative(pathEntry.path, dep.file);
					}
				});
			done(null, chunk);
		});
	},

	/**
	 * Bundles all streams together into one bundle object.
	 */
	bundleStream (instance, bundleOpts) {
		let bundle = {};
		/**
		 * Gets (or creates) an object for a package.
		 *
		 * The object returned will be already created in the bundle object, so anything placed here
		 * will end up in the bundle.
		 */
		function getPackageObject(packageName) {
			if (!bundle[packageName]) {
				bundle[packageName] = {
					files : {},
					entry : [],
					pathFiles : {}
				};
			}
			return bundle[packageName];
		}

		/**
		 * Returns the name of a package based on it's path.
		 *
		 * For now it just implements path.basename, but in the future it might do something more intelligent,
		 * like searching for the package.json.
		 */
		function getPackageNameFromPath(filePath) {
			return path.basename(filePath);
		}

		//We'll bundle all the individual stream items into one object here
		return through.obj(function toBundle(chunk, enc, done) {
			let packageName = getPackageNameFromPath(chunk.vinyl.base);
			let packageObject = getPackageObject(packageName);

			let filePath;
			let files;
			//If file is subpath of base then we can use a normal, relative require
			if (chunk.vinyl.path.startsWith(chunk.vinyl.base)) {
				filePath = path.relative(chunk.vinyl.base, chunk.vinyl.path);
				files = packageObject.files;
			} else {
				//Otherwise we'll have to search through the pathfiles
				let pathEntry = instance.options.path.find((pathEntry) => {
					return chunk.vinyl.path.startsWith(pathEntry.path);
				});
				if (!pathEntry) {
					//TODO: make sure non-path non-relative files are resolved differently
					//These are external files and shouldn't have a vinyl object attached anyway
					throw new Error("Cannot resolve file");
				}
				files = packageObject.pathFiles[pathEntry.name] = packageObject.pathFiles[pathEntry.name] || {};
				filePath = path.relative(pathEntry.path, chunk.vinyl.path);
				files = packageObject.pathFiles[pathEntry.name];
			}
			//We need to get hold of an object where we can place the content of the module.
			//Since the bundle is structured as an object representation of a file system we need to
			//walk through the bundle tree as if it was a file system.
			//With a combination of split and reduce we can walk through the bundle tree, creating path
			//entries on the fly, and finally end up at the object we're interested in.
			let target = filePath
				.split('/')
				//leading or trailing slashes will leave empty strings, so we use an identity function to
				//filter those out.
				.filter((x) => x)
				.reduce((bundle, part) => {
					if (!bundle[part]) {
						bundle[part] = {};
					}
					return bundle[part];
				}, files);

			if (bundleOpts.entries.indexOf(chunk.vinyl.path) !== -1) {
				packageObject.entry.push('./' + filePath);
			}

			//We've found our object, so we can place our info here
			//We keep the vinyl stream as it is, such that the serializer can later transform that into
			//an actual function
			target.content = chunk.vinyl;
			target.deps = chunk.deps;
			done();
		}, function finalizeBundle(cb) { //NOTE: don't use arrow functions here, it binds this and messes stuff up
			this.push(bundle);
			cb();
		});
	},
	/**
	 * Serializes a bundle object into a js file
	 */
	serialize (instance, bundleOpts) {
		return through.obj(function serialize(chunk, enc, done) {
			done(null, bundleSerializer(chunk, instance, bundleOpts));
		});
	},
	/**
	 * Beautifies a javascript object if dev is set (not needed for debug builds, just for us when developing)
	 */
	beautify (instance) {
		if (!instance.options.dev) {
			return through.obj();
		} else {
			return through.obj((chunk, enc, done) => {
				let beauty = beautify(chunk.contents.toString());
				chunk.contents = new Buffer(beauty);
				done(null, chunk);
			});
		}
	},
	/**
	 * Transforms a simple stream into a vinyl object.
	 */
	createVinylStream (instance, bundleOpts) {
		return through.obj(function createVinylStream(chunk, enc, done) {
			done(null, new VinylFile({ contents : new Buffer(chunk), path : bundleOpts.name }));
		});
	}
};


let dependencyPipeline = [transformers.wrapVinyl,
	transformers.findDependencies,
	transformers.resolveDependencies,
	transformers.compileDependencies
];

let bundlePipeline = [
	transformers.linkDependencies,
	transformers.bundleStream,
	transformers.serialize,
	transformers.beautify
];

function createPipeline(transformers, ...opts) {
	return transformers.map(binder(...opts)).map(invoke);
}

function defaultCompiler(stream, yoloader) {
	return stream
		.pipe(yoloader.processDeps());
}

function defaultDependencyProcessor(...args) {
	return combine(createPipeline(dependencyPipeline, ...args));
}

function defaultBundler(...args) {
	return combine(createPipeline(bundlePipeline, ...args));
}

class Yoloader {
	constructor(options) {
		this.dependencyProcessor = options.dependencyProcessor || defaultDependencyProcessor;
		this.bundler = options.bundler || defaultBundler;
		this.filesSeen = [];
		//We want an array of path objects, where each object is a { path, name } pair.
		//This is because at runtime we don't have full paths to resolve to, so we'll have to do it
		//name based. However, for convenience we also allow just path strings, from which we'll derive
		//the name by using path.basename on the full path. Here we convert all those strings to objects,
		//so that we don't need to bother about it later on.
		options.path = options.path || {};
		options.path = options.path.map((pathDef) => {
			if (pathDef instanceof String || typeof pathDef === 'string') {
				return { path : pathDef, name : path.basename(pathDef) };
			} else {
				return pathDef;
			}
		});
		this.path = options.path;

		this.mappings = options.mappings || {};
		this.dependencyResolvers = dependencyResolver.defaultResolvers;

		this.options = options;
	}

	resolveDependencies(compiler) {
		return this.dependencyProcessor(this, compiler);
	}
	bundle(bundleOpts) {
		return this.bundler(this, bundleOpts);
	}
}
module.exports = Yoloader;
