# figma-pi-mcp

Connects [pi-coding-agent](https://github.com/badlogic/pi-mono) to local Figma desktop MCP server.

## Instructions

- Place extension in your `/extensions` folder
- Open Figma desktop app (not the browser version)
- Enable MCP server (Dev Mode): **Inspect panel → MCP server → Enable desktop MCP server**
- Give pi a link to frame

## Configuration

The MCP server port defaults to `3845`. Override with an env var if needed:

```sh
FIGMA_MCP_PORT=3845 pi
```

Figma MCP is read-only. For editing tools, install [figma-labor](https://github.com/mkaralevich/figma-pi-labor) extension.
