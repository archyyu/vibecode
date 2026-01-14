#!/usr/bin/env node
/**
 * nanocode - minimal claude code alternative
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const https = require('https');

const API_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL = "devstral-2412";

// ANSI colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

// --- Tool implementations ---

function read(args) {
    const lines = fs.readFileSync(args.path, 'utf-8').split('\n');
    const offset = args.offset || 0;
    const limit = args.limit || lines.length;
    const selected = lines.slice(offset, offset + limit);
    return selected.map((line, idx) => 
        `${String(offset + idx + 1).padStart(4)}| ${line}`
    ).join('\n');
}

function write(args) {
    fs.writeFileSync(args.path, args.content);
    return "ok";
}

function edit(args) {
    const text = fs.readFileSync(args.path, 'utf-8');
    const { old, new: newStr } = args;
    
    if (!text.includes(old)) {
        return "error: old_string not found";
    }
    
    const count = (text.match(new RegExp(escapeRegExp(old), 'g')) || []).length;
    if (!args.all && count > 1) {
        return `error: old_string appears ${count} times, must be unique (use all=true)`;
    }
    
    const replacement = args.all 
        ? text.split(old).join(newStr)
        : text.replace(old, newStr);
    
    fs.writeFileSync(args.path, replacement);
    return "ok";
}

function glob(args) {
    const basePath = args.path || '.';
    const pattern = args.pat;
    const results = [];
    
    function walk(dir) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filepath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filepath);
                    if (stat.isDirectory()) {
                        walk(filepath);
                    } else {
                        const relativePath = path.relative('.', filepath);
                        if (matchPattern(relativePath, pattern)) {
                            results.push({ path: relativePath, mtime: stat.mtimeMs });
                        }
                    }
                } catch (e) {
                    // Skip files we can't access
                }
            }
        } catch (e) {
            // Skip directories we can't access
        }
    }
    
    walk(basePath);
    results.sort((a, b) => b.mtime - a.mtime);
    return results.map(r => r.path).join('\n') || "none";
}

function grep(args) {
    const pattern = new RegExp(args.pat);
    const basePath = args.path || '.';
    const hits = [];
    
    function walk(dir) {
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filepath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filepath);
                    if (stat.isDirectory()) {
                        walk(filepath);
                    } else {
                        const content = fs.readFileSync(filepath, 'utf-8');
                        const lines = content.split('\n');
                        lines.forEach((line, idx) => {
                            if (pattern.test(line)) {
                                hits.push(`${filepath}:${idx + 1}:${line.trimEnd()}`);
                            }
                        });
                    }
                } catch (e) {
                    // Skip files we can't read
                }
            }
        } catch (e) {
            // Skip directories we can't access
        }
    }
    
    walk(basePath);
    return hits.slice(0, 50).join('\n') || "none";
}

function bash(args) {
    try {
        const result = execSync(args.cmd, { 
            encoding: 'utf-8', 
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        return result.trim() || "(empty)";
    } catch (error) {
        return (error.stdout + error.stderr).trim() || "(empty)";
    }
}

// --- Helper functions ---

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchPattern(filepath, pattern) {
    // Simple glob pattern matching
    const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regexPattern}$`).test(filepath);
}

// --- Tool definitions ---

const TOOLS = {
    read: {
        description: "Read file with line numbers (file path, not directory)",
        schema: { path: "string", offset: "number?", limit: "number?" },
        fn: read
    },
    write: {
        description: "Write content to file",
        schema: { path: "string", content: "string" },
        fn: write
    },
    edit: {
        description: "Replace old with new in file (old must be unique unless all=true)",
        schema: { path: "string", old: "string", new: "string", all: "boolean?" },
        fn: edit
    },
    glob: {
        description: "Find files by pattern, sorted by mtime",
        schema: { pat: "string", path: "string?" },
        fn: glob
    },
    grep: {
        description: "Search files for regex pattern",
        schema: { pat: "string", path: "string?" },
        fn: grep
    },
    bash: {
        description: "Run shell command",
        schema: { cmd: "string" },
        fn: bash
    }
};

function runTool(name, args) {
    try {
        return TOOLS[name].fn(args);
    } catch (err) {
        return `error: ${err.message}`;
    }
}

function makeSchema() {
    return Object.entries(TOOLS).map(([name, tool]) => {
        const properties = {};
        const required = [];
        
        for (const [paramName, paramType] of Object.entries(tool.schema)) {
            const isOptional = paramType.endsWith('?');
            const baseType = paramType.replace('?', '');
            properties[paramName] = {
                type: baseType === 'number' ? 'integer' : baseType
            };
            if (!isOptional) {
                required.push(paramName);
            }
        }
        
        return {
            name,
            description: tool.description,
            input_schema: {
                type: "object",
                properties,
                required
            }
        };
    });
}

function callApi(messages, systemPrompt) {
    return new Promise((resolve, reject) => {
        // Convert messages to Mistral format
        const mistralMessages = [
            { role: "system", content: systemPrompt },
            ...messages
        ];
        
        const data = JSON.stringify({
            model: MODEL,
            max_tokens: 8192,
            messages: mistralMessages,
            tools: makeSchema()
        });
        
        const options = {
            hostname: 'api.mistral.ai',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.MISTRAL_API_KEY || ''}`,
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function separator() {
    const width = Math.min(process.stdout.columns || 80, 80);
    return `${DIM}${'─'.repeat(width)}${RESET}`;
}

function renderMarkdown(text) {
    return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

async function main() {
    console.log(`${BOLD}nanocode${RESET} | ${DIM}${MODEL} | ${process.cwd()}${RESET}\n`);
    
    const messages = [];
    const systemPrompt = `Concise coding assistant. cwd: ${process.cwd()}`;
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${separator()}\n${BOLD}${BLUE}❯${RESET} `
    });
    
    rl.prompt();
    
    rl.on('line', async (userInput) => {
        userInput = userInput.trim();
        console.log(separator());
        
        if (!userInput) {
            rl.prompt();
            return;
        }
        
        if (userInput === '/q' || userInput === 'exit') {
            rl.close();
            return;
        }
        
        if (userInput === '/c') {
            messages.length = 0;
            console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
            rl.prompt();
            return;
        }
        
        messages.push({ role: "user", content: userInput });
        
        try {
            // Agentic loop: keep calling API until no more tool calls
            while (true) {
                const response = await callApi(messages, systemPrompt);
                const contentBlocks = response.content || [];
                const toolResults = [];
                
                for (const block of contentBlocks) {
                    if (block.type === "text") {
                        console.log(`\n${CYAN}⏺${RESET} ${renderMarkdown(block.text)}`);
                    }
                    
                    if (block.type === "tool_use") {
                        const toolName = block.name;
                        const toolArgs = block.input;
                        const argPreview = String(Object.values(toolArgs)[0]).slice(0, 50);
                        console.log(`\n${GREEN}⏺ ${toolName.charAt(0).toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${argPreview}${RESET})`);
                        
                        const result = runTool(toolName, toolArgs);
                        const resultLines = result.split('\n');
                        let preview = resultLines[0].slice(0, 60);
                        if (resultLines.length > 1) {
                            preview += ` ... +${resultLines.length - 1} lines`;
                        } else if (resultLines[0].length > 60) {
                            preview += '...';
                        }
                        console.log(`  ${DIM}⎿  ${preview}${RESET}`);
                        
                        toolResults.push({
                            type: "tool_result",
                            tool_use_id: block.id,
                            content: result
                        });
                    }
                }
                
                messages.push({ role: "assistant", content: contentBlocks });
                
                if (toolResults.length === 0) {
                    break;
                }
                
                messages.push({ role: "user", content: toolResults });
            }
            
            console.log();
        } catch (err) {
            console.log(`${RED}⏺ Error: ${err.message}${RESET}`);
        }
        
        rl.prompt();
    });
    
    rl.on('close', () => {
        console.log('\n');
        process.exit(0);
    });
}

if (require.main === module) {
    main();
}

module.exports = { TOOLS, runTool };