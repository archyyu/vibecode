#!/usr/bin/env node
/**
 * vibecode - minimal claude code alternative
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const https = require('https');

const API_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL = "codestral-2412";

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

function undo(args) {
    const filepath = args.path;
    
    try {
        // Check if file has uncommitted changes
        const status = execSync(`git status --porcelain ${filepath}`, {
            encoding: 'utf-8',
            timeout: 5000
        }).trim();
        
        if (!status) {
            return `${filepath} has no uncommitted changes`;
        }
        
        // Restore file from git
        execSync(`git checkout -- ${filepath}`, {
            encoding: 'utf-8',
            timeout: 5000
        });
        
        return `restored ${filepath} from git repository`;
    } catch (error) {
        return `error: ${error.message}`;
    }
}

function diff(args) {
    const target = args.path || '';
    return bash({ cmd: `git diff ${target}` });
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
        .replace(/\*\*/g, '__DOUBLE_STAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__DOUBLE_STAR__/g, '.*')
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
    },
    diff: {
        description: "Show diff of file",
        schema: { path: "string" },
        fn: diff
    },
    undo: {
        description: "Undo changes in file",
        schema: { path: "string" },
        fn: undo
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
            type: "function",
            function: {
                name,
                description: tool.description,
                parameters: {
                    type: "object",
                    properties,
                    required
                }
            }
        };
    });
}

async function* callApi(messages, systemPrompt) {
    if (!process.env.MISTRAL_API_KEY) {
        throw new Error("MISTRAL_API_KEY is not set in environment");
    }

    const mistralMessages = [
        { role: "system", content: systemPrompt },
        ...messages
    ];
    
    const data = JSON.stringify({
        model: MODEL,
        max_tokens: 8192,
        messages: mistralMessages,
        tools: makeSchema(),
        tool_choice: "auto",
        stream: true
    });
    
    const options = {
        hostname: 'api.mistral.ai',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
            'Content-Length': Buffer.byteLength(data)
        }
    };
    
    const res = await new Promise((resolve, reject) => {
        const req = https.request(options, resolve);
        req.on('error', reject);
        req.write(data);
        req.end();
    });

    if (res.statusCode !== 200) {
        let body = '';
        for await (const chunk of res) body += chunk;
        throw new Error(`Mistral API Error ${res.statusCode}: ${body}`);
    }

    const rl = readline.createInterface({ input: res });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
            try {
                yield JSON.parse(trimmed.slice(6));
            } catch (e) {
                console.error("Failed to parse SSE line:", trimmed);
            }
        }
    }
}

function separator() {
    const width = Math.min(process.stdout.columns || 80, 80);
    return `${DIM}${'─'.repeat(width)}${RESET}`;
}

function renderMarkdown(text) {
    return text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
}

async function main() {
    console.log(`${BOLD}vibecode${RESET} | ${DIM}${MODEL} | ${process.cwd()}${RESET}\n`);
    
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
        
        if (userInput === '/quit' || userInput === 'exit') {
            rl.close();
            return;
        }
        
        if (userInput === '/clear') {
            messages.length = 0;
            console.log(`${GREEN}⏺ Cleared conversation${RESET}`);
            rl.prompt();
            return;
        }
        
        messages.push({ role: "user", content: userInput });
        
        try {
            // Agentic loop: keep calling API until no more tool calls
            while (true) {
                let fullContent = "";
                let toolCalls = [];
                
                process.stdout.write(`\n${CYAN}⏺${RESET} `);
                
                for await (const chunk of callApi(messages, systemPrompt)) {
                    const delta = chunk.choices[0].delta;
                    
                    if (delta.content) {
                        fullContent += delta.content;
                        process.stdout.write(renderMarkdown(delta.content));
                    }
                    
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            if (!toolCalls[tc.index]) {
                                toolCalls[tc.index] = {
                                    id: tc.id,
                                    function: { name: "", arguments: "" }
                                };
                            }
                            if (tc.function.name) toolCalls[tc.index].function.name += tc.function.name;
                            if (tc.function.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                        }
                    }
                }
                
                // Clean up empty slots in toolCalls (Mistral sometimes sends non-sequential indices)
                toolCalls = toolCalls.filter(Boolean);
                
                const assistantMessage = { role: "assistant", content: fullContent };
                if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
                messages.push(assistantMessage);

                if (toolCalls.length === 0) break;
                
                for (const toolCall of toolCalls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);
                    
                    const argPreview = String(Object.values(toolArgs)[0] || "").slice(0, 50);
                    console.log(`\n\n${GREEN}⏺ ${toolName.charAt(0).toUpperCase() + toolName.slice(1)}${RESET}(${DIM}${argPreview}${RESET})`);
                    
                    const result = runTool(toolName, toolArgs);
                    
                    const resultLines = String(result).split('\n');
                    let preview = resultLines[0]?.slice(0, 60) || "";
                    if (resultLines.length > 1) {
                        preview += ` ... +${resultLines.length - 1} lines`;
                    } else if (resultLines[0]?.length > 60) {
                        preview += '...';
                    }
                    console.log(`  ${DIM}⎿  ${preview}${RESET}`);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: String(result)
                    });
                }
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