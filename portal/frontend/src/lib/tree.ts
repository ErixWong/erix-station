// 目录树共享类型（issue #84 P5.4）：GET /api/files/tree 的单层条目。
export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
}
