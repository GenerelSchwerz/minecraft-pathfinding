import { Vec3 } from 'vec3'
import type {BlockInfo} from './cacheWorld'


export interface World {
  getBlock: (pos: Vec3) => Block | null
  getBlockInfo: (pos: Vec3) => BlockInfo
  getBlockStateId: (pos: Vec3) => number | undefined
}