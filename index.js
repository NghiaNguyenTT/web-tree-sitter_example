const fs = require('fs');
const path = require('path');
const Parser = require('web-tree-sitter');

const supportedLanguages = {
  c: "c",
  h: "c",
  // Add other languages as needed
};

const nameToLanguage = new Map();

async function loadLanguageForFileExt(fileExtension) {
  const languageName = supportedLanguages[fileExtension];
  if (!languageName) return undefined;

  const wasmPath = path.join(
    __dirname,
    process.env.NODE_ENV === "test" ? "node_modules" : "",
    "tree-sitter-wasms",
    `tree-sitter-${languageName}.wasm`
  );

  if (!fs.existsSync(wasmPath)) {
    console.warn(`WASM file not found: ${wasmPath}`);
    return undefined;
  }

  return await Parser.Language.load(wasmPath);
}

async function getParserForFile(filepath) {
  try {
    await Parser.init();
    const parser = new Parser();

    const extension = path.extname(filepath).slice(1);
    const languageName = supportedLanguages[extension];

    if (!languageName) {
      console.warn(`Unsupported file extension: ${extension}`);
      return undefined;
    }

    let language = nameToLanguage.get(languageName);
    if (!language) {
      language = await loadLanguageForFileExt(extension);
      if (language) {
        nameToLanguage.set(languageName, language);
      } else {
        return undefined;
      }
    }

    parser.setLanguage(language);
    return parser;
  } catch (e) {
    console.error("Unable to load language for file", filepath, e);
    return undefined;
  }
}

function collapsedReplacement(node) {
  if (node.type === "statement_block" || node.type === "compound_statement") {
    return "{ ... }";
  }
  return "...";
}

function firstChild(node, grammarName) {
  if (Array.isArray(grammarName)) {
    return node.children.find((child) => grammarName.includes(child.type)) || null;
  }
  return node.children.find((child) => child.type === grammarName) || null;
}

async function countTokens(text) {
  // Simple tokenization for demonstration. Replace with a proper tokenizer if needed.
  return text.split(/\s+/).length;
}

async function collapseChildren(node, code, blockTypes, collapseTypes, collapseBlockTypes, maxChunkSize) {
  code = code.slice(0, node.endIndex);
  const block = firstChild(node, blockTypes);
  const collapsedChildren = [];

  if (block) {
    const childrenToCollapse = block.children.filter((child) =>
      collapseTypes.includes(child.type)
    );
    for (const child of childrenToCollapse.reverse()) {
      const grandChild = firstChild(child, collapseBlockTypes);
      if (grandChild) {
        const start = grandChild.startPosition.index;
        const end = grandChild.endPosition.index;
        const collapsedChild =
          code.slice(child.startPosition.index, start) +
          collapsedReplacement(grandChild);
        code =
          code.slice(0, start) +
          collapsedReplacement(grandChild) +
          code.slice(end);

        collapsedChildren.unshift(collapsedChild);
      }
    }
  }
  code = code.slice(node.startPosition.index);
  let removedChild = false;
  while (
    (await countTokens(code.trim())) > maxChunkSize &&
    collapsedChildren.length > 0
  ) {
    removedChild = true;
    const childCode = collapsedChildren.pop();
    const index = code.lastIndexOf(childCode);
    if (index > 0) {
      code = code.slice(0, index) + code.slice(index + childCode.length);
    }
  }

  if (removedChild) {
    let lines = code.split("\n");
    let firstWhiteSpaceInGroup = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim() === "") {
        if (firstWhiteSpaceInGroup < 0) {
          firstWhiteSpaceInGroup = i;
        }
      } else {
        if (firstWhiteSpaceInGroup - i > 1) {
          lines = [
            ...lines.slice(0, i + 1),
            ...lines.slice(firstWhiteSpaceInGroup + 1),
          ];
        }
        firstWhiteSpaceInGroup = -1;
      }
    }

    code = lines.join("\n");
  }

  return code;
}

const FUNCTION_BLOCK_NODE_TYPES = ["block", "statement_block", "compound_statement"];
const FUNCTION_DECLARATION_NODE_TYPES = [
  "method_definition",
  "function_definition",
  "function_item",
  "function_declaration",
  "method_declaration",
];

async function constructClassDefinitionChunk(node, code, maxChunkSize) {
  return collapseChildren(
    node,
    code,
    ["block", "class_body", "declaration_list"],
    FUNCTION_DECLARATION_NODE_TYPES,
    FUNCTION_BLOCK_NODE_TYPES,
    maxChunkSize
  );
}

async function constructFunctionDefinitionChunk(node, code, maxChunkSize) {
  const bodyNode = node.children[node.children.length - 1];
  const funcText =
    code.slice(node.startPosition.index, bodyNode.startPosition.index) +
    collapsedReplacement(bodyNode);

  if (
    node.parent &&
    ["block", "declaration_list"].includes(node.parent.type) &&
    node.parent.parent &&
    ["class_definition", "impl_item"].includes(node.parent.parent.type)
  ) {
    const classNode = node.parent.parent;
    const classBlock = node.parent;
    return `${code.slice(
      classNode.startPosition.index,
      classBlock.startPosition.index
    )}...\n\n${" ".repeat(node.startPosition.column)}${funcText}`;
  }
  return funcText;
}

const collapsedNodeConstructors = {
  class_definition: constructClassDefinitionChunk,
  class_declaration: constructClassDefinitionChunk,
  impl_item: constructClassDefinitionChunk,
  function_definition: constructFunctionDefinitionChunk,
  function_declaration: constructFunctionDefinitionChunk,
  function_item: constructFunctionDefinitionChunk,
  method_declaration: constructFunctionDefinitionChunk,
};

async function maybeYieldChunk(node, code, maxChunkSize, root = true) {
  if (root || node.type in collapsedNodeConstructors) {
    const tokenCount = await countTokens(node.text);
    if (tokenCount < maxChunkSize) {
      return {
        content: node.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      };
    }
  }
  return undefined;
}

const globalContext = {
  variables: new Map(),
  functions: new Map(),
  macros: new Map(),
  currentFunction: null,
  currentFile: null,
};

function processNode(node, code, filePath) {
  globalContext.currentFile = filePath;
  const details = extractNodeDetails(node, code);
  updateGlobalContext(details, node);
  return details;
}

function extractNodeDetails(node, code) {
  const details = {
    type: node.type,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    content: node.text,
  };

  switch (node.type) {
    case 'function_definition':
      details.name = node.childForFieldName('declarator')?.text;
      details.returnType = node.childForFieldName('type')?.text;
      details.parameters = extractParameters(node.childForFieldName('parameters'));
      details.body = extractFunctionBody(node.childForFieldName('body'), code);
      globalContext.currentFunction = details.name;
      break;
    case 'declaration':
      details.declarationType = node.childForFieldName('type')?.text;
      details.declarationName = node.childForFieldName('declarator')?.text;
      if (details.declarationType?.includes('*')) {
        details.isPointer = true;
      }
      break;
    case 'identifier':
      details.name = node.text;
      details.usage = 'access';
      break;
    case 'pointer_expression':
      details.pointerName = node.childForFieldName('argument')?.text;
      details.usage = 'dereference';
      break;
    case 'call_expression':
      details.functionName = node.childForFieldName('function')?.text;
      details.arguments = extractArguments(node.childForFieldName('arguments'));
      break;
    case 'macro_definition':
      details.name = node.childForFieldName('name')?.text;
      details.value = node.childForFieldName('value')?.text;
      break;
    case 'preproc_include':
      details.path = node.childForFieldName('path')?.text;
      break;
  }

  return details;
}

function extractParameters(parametersNode) {
  if (!parametersNode) return [];
  return parametersNode.children
    .filter(child => child.type === 'parameter_declaration')
    .map(param => ({
      type: param.childForFieldName('type')?.text,
      name: param.childForFieldName('declarator')?.text,
    }));
}

function extractArguments(argumentsNode) {
  if (!argumentsNode) return [];
  return argumentsNode.children
    .filter(child => child.type !== ',')
    .map(arg => arg.text);
}

function extractFunctionBody(bodyNode, code) {
  if (!bodyNode) return '';
  const bodyDetails = {
    variables: [],
    controlStructures: [],
    functionCalls: [],
  };

  traverseNode(bodyNode, (node) => {
    switch (node.type) {
      case 'declaration':
        bodyDetails.variables.push({
          type: node.childForFieldName('type')?.text,
          name: node.childForFieldName('declarator')?.text,
          line: node.startPosition.row + 1,
        });
        break;
      case 'if_statement':
      case 'for_statement':
      case 'while_statement':
      case 'do_statement':
        bodyDetails.controlStructures.push({
          type: node.type,
          condition: node.childForFieldName('condition')?.text,
          line: node.startPosition.row + 1,
        });
        break;
      case 'call_expression':
        bodyDetails.functionCalls.push({
          name: node.childForFieldName('function')?.text,
          arguments: extractArguments(node.childForFieldName('arguments')),
          line: node.startPosition.row + 1,
        });
        break;
    }
  });

  return bodyDetails;
}

function traverseNode(node, callback) {
  callback(node);
  node.children.forEach(child => traverseNode(child, callback));
}

function updateGlobalContext(details, node) {
  switch (details.type) {
    case 'function_definition':
      globalContext.functions.set(details.name, {
        ...details,
        file: globalContext.currentFile,
        calls: [],
      });
      break;
    case 'declaration':
      if (details.declarationName) {
        globalContext.variables.set(details.declarationName, {
          ...details,
          file: globalContext.currentFile,
          function: globalContext.currentFunction,
          accesses: [],
        });
      }
      break;
    case 'identifier':
      const variable = globalContext.variables.get(details.name);
      if (variable) {
        variable.accesses.push({
          file: globalContext.currentFile,
          function: globalContext.currentFunction,
          line: details.startLine,
        });
      }
      break;
    case 'call_expression':
      const func = globalContext.functions.get(details.functionName);
      if (func) {
        func.calls.push({
          file: globalContext.currentFile,
          function: globalContext.currentFunction,
          line: details.startLine,
        });
      }
      break;
    case 'macro_definition':
      globalContext.macros.set(details.name, {
        ...details,
        file: globalContext.currentFile,
        uses: [],
      });
      break;
  }

  // Process child nodes
  for (const child of node.children) {
    processNode(child, globalContext.currentFile);
  }
}

async function* getSmartCollapsedChunks(node, code, maxChunkSize, filePath, root = true) {
  const chunk = await maybeYieldChunk(node, code, maxChunkSize, root);
  if (chunk) {
    yield {
      ...chunk,
      ...processNode(node, code, filePath),
    };
    return;
  }

  if (node.type in collapsedNodeConstructors) {
    yield {
      content: await collapsedNodeConstructors[node.type](node, code, maxChunkSize),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...processNode(node, code, filePath),
    };
  }

  for (const child of node.children) {
    yield* getSmartCollapsedChunks(child, code, maxChunkSize, filePath, false);
  }
}


async function processFile(filePath, outputDir) {
  const parser = await getParserForFile(filePath);
  if (!parser) {
    console.warn(`Skipping unsupported file: ${filePath}`);
    return;
  }

  const code = fs.readFileSync(filePath, 'utf8');
  const tree = parser.parse(code);
  
  const fileName = path.basename(filePath);
  const maxChunkSize = 1000; // Adjust this value as needed
  
  let chunkIndex = 0;
  for await (const chunk of getSmartCollapsedChunks(tree.rootNode, code, maxChunkSize)) {
    const chunkName = `${fileName}_chunk_${chunkIndex++}`;
    writeChunkToFile(outputDir, chunkName, chunk, filePath);
  }
}

async function* getSmartCollapsedChunks(node, code, maxChunkSize, root = true) {
  const chunk = await maybeYieldChunk(node, code, maxChunkSize, root);
  if (chunk) {
    yield {
      ...chunk,
      ...extractNodeDetails(node, code),
    };
    return;
  }

  if (node.type in collapsedNodeConstructors) {
    yield {
      content: await collapsedNodeConstructors[node.type](
        node,
        code,
        maxChunkSize
      ),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...extractNodeDetails(node, code),
    };
  }

  for (const child of node.children) {
    yield* getSmartCollapsedChunks(child, code, maxChunkSize, false);
  }
}

function writeChunkToFile(outputDir, chunkName, chunk, filePath) {
  // Create a unique identifier for the file based on its path
  const relativeFilePath = path.relative(process.cwd(), filePath);
  const fileIdentifier = relativeFilePath.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  
  // Combine the file identifier with the chunk name
  const uniqueChunkName = `${fileIdentifier}_${chunkName}`;
  const sanitizedName = uniqueChunkName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const outputPath = path.join(outputDir, `${sanitizedName}.txt`);
  
  let content = `File: ${filePath}\n` +
                `File Name: ${path.basename(filePath)}\n` +
                `Node Type: ${chunk.type}\n` +
                `Start Line: ${chunk.startLine}\n` +
                `End Line: ${chunk.endLine}\n`;

  if (chunk.type === 'function_definition') {
    content += `Function Name: ${chunk.name}\n`;
    content += `Return Type: ${chunk.returnType}\n`;
    content += `Parameters:\n${chunk.parameters.map(p => `  - ${p.type} ${p.name}`).join('\n')}\n`;
    content += `Function Body:\n`;
    content += `  Variables:\n${chunk.body.variables.map(v => `    - ${v.type} ${v.name} (line ${v.line})`).join('\n')}\n`;
    content += `  Control Structures:\n${chunk.body.controlStructures.map(cs => `    - ${cs.type} (line ${cs.line}): ${cs.condition}`).join('\n')}\n`;
    content += `  Function Calls:\n${chunk.body.functionCalls.map(fc => `    - ${fc.name}(${fc.arguments.join(', ')}) (line ${fc.line})`).join('\n')}\n`;
  } else {
    // Add other node type specific information here
    if (chunk.name) content += `Name: ${chunk.name}\n`;
    if (chunk.declarationType) content += `Declaration Type: ${chunk.declarationType}\n`;
    if (chunk.declarationName) content += `Declaration Name: ${chunk.declarationName}\n`;
    if (chunk.isPointer) content += `Is Pointer: Yes\n`;
    if (chunk.usage) content += `Usage: ${chunk.usage}\n`;
    if (chunk.functionName) content += `Function Name: ${chunk.functionName}\n`;
    if (chunk.arguments) content += `Arguments: ${chunk.arguments.join(', ')}\n`;
    if (chunk.path) content += `Include Path: ${chunk.path}\n`;
  }

  content += `\nContent:\n${chunk.content}\n`;

  fs.writeFileSync(outputPath, content);
}

async function processDirectory(dir, outputDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      await processDirectory(fullPath, outputDir);
    } else if (entry.isFile() && supportedLanguages[path.extname(fullPath).slice(1)]) {
      await processFile(fullPath, outputDir);
    }
  }
}

async function main() {
  const sourceDir = process.argv[2] || '.';
  const outputDir = process.argv[3] || 'output';
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  await processDirectory(sourceDir, outputDir);
  console.log('Processing complete.');
}

main().catch(console.error);
