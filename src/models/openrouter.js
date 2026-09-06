import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url) {
        this.model_name = model_name;

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