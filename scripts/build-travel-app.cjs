const path=require('node:path');
const esbuild=require('esbuild');
const modules=path.dirname(path.dirname(require.resolve('react/package.json')));
esbuild.buildSync({entryPoints:[path.join(__dirname,'..','travel-src/main.tsx')],outfile:path.join(__dirname,'..','travel-expenses.js'),bundle:true,minify:true,format:'esm',target:'es2020',jsx:'automatic',nodePaths:[modules],legalComments:'eof',logLevel:'info'});
