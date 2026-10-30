import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readSecret } from '../packages/cli/src/secret';

// The terminal, faked: raw mode, and keys arriving as data, the way Node delivers them.
function terminal() {
  const input = Object.assign(new EventEmitter(), {
    raw: false,
    flowing: false,
    setRawMode(on: boolean) {
      input.raw = on;
      return input;
    },
    setEncoding() {
      return input;
    },
    resume() {
      input.flowing = true;
      return input;
    },
    pause() {
      input.flowing = false;
      return input;
    },
  });
  const written: string[] = [];
  return {
    input,
    output: { write: (text: string) => written.push(text) },
    written,
  };
}

describe('reading a secret at the terminal', () => {
  it('keeps the question on screen and shows nothing that is typed', async () => {
    const t = terminal();
    const answer = readSecret('Value of RPC_KEY: ', t.input, t.output);
    expect(t.input.raw).toBe(true);
    expect(t.input.flowing).toBe(true);
    t.input.emit('data', 'ab1');
    t.input.emit('data', '2\r');
    expect(await answer).toBe('ab12');
    // The question, then the line ends: nothing redrawn over it, and no echo.
    expect(t.written).toEqual(['Value of RPC_KEY: ', '\n']);
    expect(t.input.raw).toBe(false);
    expect(t.input.flowing).toBe(false);
    expect(t.input.listenerCount('data')).toBe(0);
  });

  it('takes a pasted value, Backspace and Ctrl+D, and leaves special keys out', async () => {
    const t = terminal();
    const pasted = readSecret('Key: ', t.input, t.output);
    t.input.emit('data', 'f00dcafe\r\n');
    expect(await pasted).toBe('f00dcafe');
    const corrected = readSecret('Key: ', t.input, t.output);
    t.input.emit('data', 'secret');
    t.input.emit('data', '\u001b[A');
    t.input.emit('data', '\u007f\u007fX\u0004');
    expect(await corrected).toBe('secrX');
    expect(t.written.join('')).not.toMatch(/f00d|secr/);
  });

  it('stops on Ctrl+C and gives the terminal back', async () => {
    const t = terminal();
    const answer = readSecret('Key: ', t.input, t.output);
    t.input.emit('data', 'abc\u0003');
    expect(await answer).toBeNull();
    expect(t.input.raw).toBe(false);
    expect(t.input.listenerCount('data')).toBe(0);
  });
});
