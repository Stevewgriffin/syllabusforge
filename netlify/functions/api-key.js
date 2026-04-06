// Returns the Anthropic API key to the client.
// This is acceptable for internal tools where the app is not public-facing.

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: process.env.ANTHROPIC_API_KEY || '' }),
  };
};
