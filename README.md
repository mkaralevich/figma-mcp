> Made @ Shopify

# pi-figma-mcp

Connects [pi-coding-agent](https://github.com/badlogic/pi-mono) to the Figma desktop MCP server. No auth required.

## Install

Message `pi`:

```
Install this pi-extension https://github.com/mkaralevich/pi-figma-mcp
```

Or place extension in your `/extensions` folder.

## Use

1. Open Figma desktop app
2. Enable MCP server: **Dev Mode → Inspect panel → MCP server → Enable desktop MCP server**
3. Footer shows `figma ✓` when connected
4. Give pi a link to a frame or select a node in Figma

## Configuration

```sh
FIGMA_MCP_PORT=3845 pi   # default port, override if needed
```

## Remote MCP

For remote-only features (`generate_figma_design`, `create_new_file`) or browser-based Figma, use [pi-figma-remote-mcp](https://github.com/mkaralevich/pi-figma-remote-mcp) instead.

## Canvas editing

Figma MCP provides screenshots, design context, and library search. For canvas editing, install [pi-figma-labor](https://github.com/mkaralevich/pi-figma-labor) extension.
