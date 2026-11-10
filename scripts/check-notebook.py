"""Validate and execute the committed notebook with live LLM mode disabled."""
import argparse
import ast
from pathlib import Path

import nbformat
from nbclient import NotebookClient

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, help="Optional local path for the executed notebook; never overwrite the committed input.")
args = parser.parse_args()
path = root / "notebooks" / "01_ai_core_tool_lab.ipynb"
notebook = nbformat.read(path, as_version=4)
nbformat.validate(notebook)
live_switches = []
for cell in notebook.cells:
    if cell.cell_type == "code":
        if cell.outputs or cell.execution_count is not None:
            raise RuntimeError("The committed notebook must have no saved execution output.")
        tree = ast.parse(cell.source)
        compile(tree, str(path), "exec")
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "USE_LIVE_LLM" for target in node.targets):
                live_switches.append(isinstance(node.value, ast.Constant) and node.value.value is False)
if live_switches != [True]:
    raise RuntimeError("Offline verification requires exactly one USE_LIVE_LLM = False assignment.")
if args.output and args.output.resolve() == path.resolve():
    raise ValueError("Executed output must not overwrite the committed notebook.")
client = NotebookClient(notebook, timeout=120, kernel_name="python3", resources={"metadata": {"path": str(root)}})
client.execute()
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(notebook, args.output)
print(f"Notebook validated and executed offline: {len(notebook.cells)} cells.")
