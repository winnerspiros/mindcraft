import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this._restartAttempts = 0;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });

        // If the agent survives this long, reset the crash-backoff counter.
        if (this._backoffResetTimer) clearTimeout(this._backoffResetTimer);
        this._backoffResetTimer = setTimeout(() => {
            this._restartAttempts = 0;
        }, 60000);

        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            logoutAgent(this.name);

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                this._restartAttempts++;
                // Escalating backoff so a brief server outage (crash/reboot) can't
                // permanently strand the bot. 10s, 20s, 30s... capped at 60s.
                const delay = Math.min(10000 * this._restartAttempts, 60000);
                console.log(`Restarting agent in ${Math.round(delay / 1000)}s (attempt ${this._restartAttempts})...`);
                setTimeout(() => this.start(true, 'Agent process restarted.', count_id, this.port), delay);
            }
        });

        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running) return;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);

            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                clearTimeout(restartTimeout);
                console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                this._restartAttempts = 0;
                this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(); // sends SIGINT
        } else {
            this._restartAttempts = 0;
            this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}