import { useEffect, useMemo, useState } from "react";
import type { FileNode } from "../types";

interface FileTreeProps {
  nodes: FileNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function collectDirPaths(nodes: FileNode[], acc: Set<string>): void {
  for (const node of nodes) {
    if (node.isDir) {
      acc.add(node.path);
      collectDirPaths(node.children, acc);
    }
  }
}

export default function FileTree({ nodes, selectedPath, onSelect }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    const initial = new Set<string>();
    collectDirPaths(nodes, initial);
    setExpanded(initial);
  }, [nodes]);

  const sortedNodes = useMemo(() => {
    const sorter = (a: FileNode, b: FileNode) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, "zh-CN");
    };

    const deepSort = (source: FileNode[]): FileNode[] => {
      return [...source]
        .sort(sorter)
        .map((node) => ({
          ...node,
          children: deepSort(node.children),
        }));
    };

    return deepSort(nodes);
  }, [nodes]);

  const toggleExpanded = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderNode = (node: FileNode, depth: number): JSX.Element => {
    const isExpanded = expanded.has(node.path);
    const isSelected = selectedPath === node.path;

    if (node.isDir) {
      return (
        <div key={node.path}>
          <button
            type="button"
            className="tree-item tree-dir"
            style={{ paddingLeft: `${depth * 16 + 10}px` }}
            onClick={() => toggleExpanded(node.path)}
          >
            <span className="tree-chevron">{isExpanded ? "▾" : "▸"}</span>
            <span className="tree-label">{node.name}</span>
          </button>
          {isExpanded && node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return (
      <button
        key={node.path}
        type="button"
        className={`tree-item tree-file${isSelected ? " selected" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 30}px` }}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        <span className="tree-label">{node.name}</span>
      </button>
    );
  };

  if (sortedNodes.length === 0) {
    return <div className="empty-hint">此目录下没有 PDF 文件</div>;
  }

  return <div className="file-tree">{sortedNodes.map((node) => renderNode(node, 0))}</div>;
}
