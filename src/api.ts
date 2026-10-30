export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      // The browser sets a multipart type, with its boundary, for file uploads.
      ...(options?.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      'X-Shipcel-Request': '1',
      ...options?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({
      error: 'The workspace is unavailable. Try again.',
    }))) as { error?: string };
    throw new Error(body.error || 'The request failed.');
  }
  return response.json() as Promise<T>;
}

export async function downloadKit(id: string, name: string) {
  const response = await fetch(`/api/projects/${id}/export`, {
    method: 'POST',
    headers: { 'X-Shipcel-Request': '1' },
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error || 'Could not generate the starter kit.');
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-shipcel.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
