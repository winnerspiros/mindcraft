import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};

        let config = {};
        config.baseURL = url || 'https://openrouter.ai/api/v1';

        const apiKey = getKey('OPENROUTER_API_KEY');
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
        }

        // Pass the API key to OpenAI compatible Api
        config.apiKey = apiKey; 

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq='') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        // Choose a valid model from openrouter.ai (for example, "openai/gpt-4o")
        const pack = {
            model: this.model_name,
            messages,
        };

        // WIRE PROFILE PARAMS THROUGH. The Mindcraft base dropped the 3rd
        // constructor arg, so `max_tokens`/`temperature` from the profile were
        // silently ignored for openrouter. Consequences we now fix:
        //   - max_tokens: live bot had NO output cap. gpt-4o-mini's default
        //     ceiling is 16k tokens; a single pigment-of-fancy ramble (or a
        //     bug hitting finish_reason=length) could burn a large, billable
        //     output with no result used. A cap stops runaway cost.
        //   - temperature: honor the profile if it sets one.
        // Only pass keys the profile explicitly set, so default behavior is
        // unchanged unless configured.
        for (const k of ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
            if (this.params[k] !== undefined && this.params[k] !== null)
                pack[k] = this.params[k];
        }
        // OpenRouter-compatible streaming keeps the request identical otherwise.

        // NOTE: no explicit cache_control marker here. gpt-4o-mini prompt
        // caching is AUTOMATIC on OpenRouter — any prompt prefix >1024 tokens
        // reused within ~5-10 min is billed at the (half-price) cached-input
        // rate with zero opt-in (verified: input_cache_read=0.000000075 vs
        // prompt=0.00000015). The stable 41KB persona + real_identity leads
        // every chat turn, so the large static prefix is cached automatically.
        // A manual cache_control would be a schema-stripped field on the
        // strictFormat-converted user message — dead weight, so we skip it.
        // Only pass `stop` when a stop sequence is actually configured. The Mindcraft
        // default was '*' which assumes a thought/action delimiter — but this kawaii
        // persona writes *hugs* / *giggles*, so '*' chops every reply mid-emote into
        // garbage and often returns empty (→ 20s retry → "no response").
        if (stop_seq)
            pack.stop = stop_seq;

        let res = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                console.log('Awaiting openrouter api response...');
                let completion = await this.openai.chat.completions.create(pack);
                if (!completion?.choices?.[0]) {
                    console.error('No completion or choices returned:', completion);
                    return '';
                }
                if (completion.choices[0].finish_reason === 'length') {
                    throw new Error('Context length exceeded');
                }
                console.log('Received.');
                // Token-cost observability: surface what the provider billed so
                // the token-optimization work is measurable, not assumed. usage
                // carries prompt/completion + cached-vs-uncached input when the
                // provider reports it.
                const u = completion.usage || {};
                const cached = u.prompt_tokens_details ? (u.prompt_tokens_details.cached_tokens || 0) : (u.prompt_cache_hit_tokens || 0);
                const total = u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0);
                console.log(`[tokens] in=${u.prompt_tokens ?? '?'} cached=${cached} out=${u.completion_tokens ?? '?'} total=${total}`);
                res = completion.choices[0].message.content;
                if (typeof res !== 'string' || res.trim() === '') {
                    // some reasoning-flavoured responses park text in `reasoning` and leave content null;
                    // also covers transient nulls from the provider. Retry before giving up.
                    console.warn(`Empty/null content (attempt ${attempt + 1}). reasoning=${JSON.stringify(completion.choices[0].message.reasoning)?.slice(0, 80)}`);
                    if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
                } else {
                    break;
                }
            } catch (err) {
                console.error('Error while awaiting response:', err);
                if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
                // If the error indicates a context-length problem, we can slice the turns array, etc.
                res = '';
            }
        }
        if (typeof res !== 'string' || res.trim() === '') {
            res = '';
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        
        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        if (text.length > 8191)
            text = text.slice(0, 8191);
        const embedding = await this.openai.embeddings.create({
            model: 'openai/text-embedding-3-small',
            input: text,
            encoding_format: 'float',
        });
        return embedding.data[0].embedding;
    }
}