import { BinaryHeapOpenSet } from './heap'
import { PathData, PathNode } from './node'

export interface Goal<Data> {
  isEnd: (node: Data) => boolean
  heuristic: (node: Data) => number
}

export interface Algorithm<Data extends PathData = PathData> {
  movementProvider: MovementProvider<Data>
  compute: () => Path<Data, Algorithm<Data>> | null
  makeResult: (status: string, node: PathNode<Data>) => Path<Data, Algorithm<Data>>
}

export interface Path<Data extends PathData, Alg extends Algorithm<Data>> {
  status: string // 'noPath' | 'timeout' | 'partial' | 'success'
  cost: number
  calcTime: number
  visitedNodes: number
  generatedNodes: number
  path: Data[]
  context: Alg
}

export interface MovementProvider<Data extends PathData> {
  sanitize: () => boolean
  getNeighbors: (org: Data, set: Set<string>) => Data[]
}

export { PathNode } from './node'
