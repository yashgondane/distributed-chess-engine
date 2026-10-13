const configuredNodes = import.meta.env.VITE_NODES;

function parseNodes(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return value.split(',').map((url, index) => ({ id: index + 1, url: url.trim() }));
  }
  return null;
}

export const NODES = parseNodes(configuredNodes) || [1, 2, 3, 4].map((id) => ({
  id,
  url: `http://localhost:${4000 + id}`,
}));
