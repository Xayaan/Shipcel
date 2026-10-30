// Reads a secret typed or pasted at the terminal without showing it. Readline can't do this:
// it redraws its line when it starts, which erased the question, and it echoes what is typed
// through an internal method a caller can no longer replace (both seen on 23 Oct 2026, with
// Node 22 and 24). So the terminal goes into raw mode, which echoes nothing, and the keys are
// collected here: Enter (or Ctrl+D) finishes, Backspace removes the last character, and Ctrl+C
// stops, answering null.
export type SecretInput = {
  setRawMode(on: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
};

export function readSecret(
  question: string,
  input: SecretInput,
  output: { write(text: string): unknown },
): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    const finish = (answer: string | null) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      resolve(answer);
    };
    function onData(chunk: string) {
      // An arrow or another special key arrives as one escape sequence: not part of a secret.
      if (chunk.startsWith('\u001b')) return;
      for (const key of chunk) {
        if (key === '\r' || key === '\n' || key === '\u0004')
          return finish(value);
        if (key === '\u0003') return finish(null);
        if (key === '\u007f' || key === '\b') value = value.slice(0, -1);
        else if (key >= ' ') value += key;
      }
    }
    output.write(question);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
