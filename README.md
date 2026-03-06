# figma-pi-mcp

A pi extension that bridges the Figma desktop app's local MCP server into pi as native tools.

> See also [figma-pi-labor](https://github.com/mkaralevich/figma-pi-labor) — reads and modifies Figma designs directly via the Plugin API.

## Requirements

- Figma desktop app (not the browser version)
- A Design file open in Dev Mode
- MCP server enabled: **Inspect panel → MCP server → Enable desktop MCP server**

## Setup

Copy `index.ts` into your pi extensions directory:

```
~/.pi/agent/extensions/figma-pi-mcp.ts
```

## Configuration

The MCP server port defaults to `3845`. Override with an env var if needed:

```sh
FIGMA_MCP_PORT=3845 pi
```

## Usage

Start pi with Figma open. The status bar shows `figma ✓` when connected.

Run `/figma-mcp` to check connection status and list available tools.
