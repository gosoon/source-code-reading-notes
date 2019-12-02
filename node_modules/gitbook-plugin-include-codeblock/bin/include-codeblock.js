#!/usr/bin/env node
'use strict';
const meow = require('meow');
const fs = require('fs');
const path = require('path');
const parse = require("../lib/parser").parse;
const cli = meow(`
    Usage
      $ include-codeblock <input-file-path> --output <output-file-path>

    Options
      --output Output to write index json file
  
    Other Options:
      same with gitbook config
      For example, --unindent=true 
    
    Example:
      $ include-codeblock ./README.md --output RENDER_README.md
`);
// main
const input = cli.input[0];
if (!input) {
    cli.showHelp();
}
const inputContent = fs.readFileSync(input, "utf-8");
const baseDir = path.dirname(path.resolve(process.cwd(), input));
const replacements = parse(inputContent, baseDir, cli.flags);
const replaceContent = (inputContent, replacements) => {
    replacements.forEach(result => {
        const { target, replaced } = result;
        inputContent = inputContent.replace(target, replaced);
    });
    return inputContent;
};
const outputContent = replaceContent(inputContent, replacements);
if (cli.flags.output) {
    fs.writeFileSync(cli.flags.output, outputContent, "utf-8");
} else {
    console.log(outputContent);
}
