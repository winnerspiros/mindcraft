import { createRequire } from 'module';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// prefix -> module filename. Mirrors each model class's static `prefix`.
// The old code eagerly `import()`ed every model module at startup, which pulled in
// ~10 LLM SDKs (openai/anthropic/google/mistral/groq/cerebras/replicate/azure/...)
// into RAM even though a profile only ever uses one. This lazy-loads just the SDK
// the profile references via a synchronous require() (Node >=20.19 supports require(esm)).
const PREFIX_FILE = {
    azure: 'azure.js',
    cerebras: 'cerebras.js',
    anthropic: 'claude.js',
    deepseek: 'deepseek.js',
    google: 'gemini.js',
    glhf: 'glhf.js',
    openai: 'gpt.js',
    xai: 'grok.js',
    groq: 'groq.js',
    huggingface: 'huggingface.js',
    hyperbolic: 'hyperbolic.js',
    lmstudio: 'lmstudio.js',
    mercury: 'mercury.js',
    mistral: 'mistral.js',
    novita: 'novita.js',
    ollama: 'ollama.js',
    openrouter: 'openrouter.js',
    qwen: 'qwen.js',
    replicate: 'replicate.js',
    vllm: 'vllm.js',
};

// lazily-populated cache: prefix -> model class
const apiMap = {};

function _register(mod) {
    for (const exported of Object.values(mod)) {
        if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
            const prefix = exported.prefix;
            if (typeof prefix === 'string' && prefix.length > 0) {
                apiMap[prefix] = exported;
            }
        }
    }
}

function _loadPrefix(prefix) {
    if (apiMap[prefix])
        return apiMap[prefix];
    const file = PREFIX_FILE[prefix];
    if (!file) {
        // unknown prefix: fall back to a full scan so newly-added models keep working
        const files = fs.readdirSync(__dirname)
            .filter(f => f.endsWith('.js') && f !== '_model_map.js' && f !== 'prompter.js');
        for (const f of files) {
            try {
                _register(require(path.join(__dirname, f)));
            } catch (e) {
                console.warn('Failed to load model module:', f, e?.message || e);
            }
        }
        return apiMap[prefix];
    }
    try {
        _register(require(path.join(__dirname, file)));
    } catch (e) {
        console.warn('Failed to load model module:', file, e?.message || e);
    }
    return apiMap[prefix];
}

export function selectAPI(profile) {
    if (typeof profile === 'string' || profile instanceof String) {
        profile = {model: profile};
    }
    // backwards compatibility with local->ollama
    if (profile.api?.includes('local') || profile.model?.includes('local')) {
        profile.api = 'ollama';
        if (profile.model) {
            profile.model = profile.model.replace('local', 'ollama');
        }
    }
    if (!profile.api) {
        const api = Object.keys(PREFIX_FILE).find(key => profile.model?.startsWith(key));
        if (api) {
            profile.api = api;
        }
        else {
            // check for some common models that do not require prefixes
            if (profile.model.includes('gpt') || profile.model.includes('o1')|| profile.model.includes('o3'))
                profile.api = 'openai';
            else if (profile.model.includes('claude'))
                profile.api = 'anthropic';
            else if (profile.model.includes('gemini'))
                profile.api = "google";
            else if (profile.model.includes('grok'))
                profile.api = 'xai';
            else if (profile.model.includes('mistral'))
                profile.api = 'mistral';
            else if (profile.model.includes('deepseek'))
                profile.api = 'deepseek';
            else if (profile.model.includes('qwen'))
                profile.api = 'qwen';
        }
        if (!profile.api) {
            throw new Error('Unknown model:', profile.model);
        }
    }
    let model_name = profile.model.replace(profile.api + '/', ''); // remove prefix
    profile.model = model_name === "" ? null : model_name; // if model is empty, set to null
    return profile;
}

export function createModel(profile) {
    if (!!PREFIX_FILE[profile.model]) {
        // if the model value is an api (instead of a specific model name)
        // then set model to null so it uses the default model for that api
        profile.model = null;
    }
    const ModelClass = _loadPrefix(profile.api);
    if (!ModelClass) {
        throw new Error('Unknown api:', profile.api);
    }
    const model = new ModelClass(profile.model, profile.url, profile.params);
    return model;
}
