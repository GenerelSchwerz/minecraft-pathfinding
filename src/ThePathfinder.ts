import { Bot, BotEvents } from 'mineflayer'
import { AStar as AAStar } from './abstract/algorithms/astar'
import { AStar, Path, PathProducer } from './mineflayer-specific/algs'
import * as goals from './mineflayer-specific/goals'
import { Vec3 } from 'vec3'
import { Move } from './mineflayer-specific/move'
import { BlockInfo, CacheSyncWorld } from './mineflayer-specific/world/cacheWorld'
import { AbortError, CancelError, ResetError } from './mineflayer-specific/exceptions'
import {
  BuildableMoveExecutor,
  BuildableMoveProvider,
  MovementHandler,
  MovementOptions,
  MovementSetup,
  ExecutorMap,
  MovementExecutor,
  DEFAULT_MOVEMENT_OPTS
} from './mineflayer-specific/movements'

import {
  ParkourForward,
  Diagonal,
  Forward,
  ForwardDropDown,
  ForwardJump,
  IdleMovement,
  StraightDown,
  StraightUp
} from './mineflayer-specific/movements/movementProviders'

import {
  ParkourForwardExecutor,
  ForwardDropDownExecutor,
  NewForwardExecutor,
  NewForwardJumpExecutor,
  StraightDownExecutor,
  StraightUpExecutor,
  IdleMovementExecutor
} from './mineflayer-specific/movements/movementExecutors'
import { DropDownOpt, ForwardJumpUpOpt, StraightAheadOpt } from './mineflayer-specific/post/optimizers'
import { BuildableOptimizer, OptimizationSetup, MovementOptimizer, OptimizationMap, Optimizer } from './mineflayer-specific/post'
import { ContinuousPathProducer, PartialPathProducer } from './mineflayer-specific/pathProducers'
import { Block, ResetReason } from './types'
import { Task } from '@nxg-org/mineflayer-util-plugin'

import { reconstructPath } from './abstract/algorithms'

export interface PathfinderOptions {
  partialPathProducer: boolean
  partialPathLength: number
}

const DEFAULT_PATHFINDER_OPTS: PathfinderOptions = {
  partialPathProducer: false,
  partialPathLength: 50
}

const EMPTY_VEC = new Vec3(0, 0, 0)

/**
 * These are the default movement types and their respective executors.
 */
const DEFAULT_PROVIDER_EXECUTORS = [
  [Forward, NewForwardExecutor],
  [ForwardJump, NewForwardJumpExecutor],
  [ForwardDropDown, ForwardDropDownExecutor],
  [Diagonal, NewForwardExecutor],
  [StraightDown, StraightDownExecutor],
  [StraightUp, StraightUpExecutor],
  [ParkourForward, ParkourForwardExecutor]
] as Array<[BuildableMoveProvider, BuildableMoveExecutor]>

/**
 * Due to locality caching of blocks being implemented,
 * We want the most complicated movements to be called first,
 * as they load more blocks.
 *
 * Human logic keeps simple at front, complicated at back,
 * So for simplicity I reverse the array.
 */
DEFAULT_PROVIDER_EXECUTORS.reverse()

/**
 * This is the default optimization setup.
 *
 * Optimizers are used to optimize the path produced by the A* algorithm.
 *
 * They can reveal patterns at calculation time otherwise not noticeable at execution time.
 */
const DEFAULT_OPTIMIZERS = [
  [Forward, StraightAheadOpt],
  [Diagonal, StraightAheadOpt],
  [ForwardDropDown, DropDownOpt],
  [ForwardJump, ForwardJumpUpOpt]
] as Array<[BuildableMoveProvider, BuildableOptimizer]>

const DEFAULT_SETUP = new Map(DEFAULT_PROVIDER_EXECUTORS)

const DEFAULT_OPTIMIZATION = new Map(DEFAULT_OPTIMIZERS)

// Temp typing.
type PathInfo = Path
type PathGenerator = AsyncGenerator<PathGeneratorResult, PathGeneratorResult | null, unknown>
interface PathGeneratorResult {
  result: PathInfo
  astarContext: AAStar<Move>
}

interface PerformOpts {
  errorOnReset?: boolean
  errorOnAbort?: boolean
}

/**
 * Eventually, I want all pathfinder logic entirely off thread.
 *
 * This means that the pathfinder will be able to calculate paths while the bot is doing other things.
 *
 * However, this is not the case right now, as prismarine-world needs a rewrite
 * and eventually, this pathfinder code will too.
 *
 * That will be a while, but remember to code this with that in mind.
 */
export class ThePathfinder {
  astar: AStar | null
  world: CacheSyncWorld
  movements: ExecutorMap
  optimizers: OptimizationMap
  defaultMoveSettings: MovementOptions
  pathfinderSettings: PathfinderOptions

  private executeTask: Task<void, void> = Task.createDoneTask()
  private wantedGoal?: goals.Goal
  public abortCalculation = false
  private userAborted = false

  private currentGotoGoal?: goals.Goal
  private currentExecutingPath?: Move[]
  private currentMove?: Move
  private currentExecutor?: MovementExecutor

  private resetReason?: ResetReason
  private _currentProducer?: PathProducer

  public get currentAStar (): AStar | undefined {
    return this._currentProducer?.getAstarContext()
  }

  public get currentProducer (): PathProducer | undefined {
    return this._currentProducer
  }

  public get isPathing (): boolean {
    return this.executeTask.done
  }

  reconstructPath = reconstructPath

  constructor (
    private readonly bot: Bot,
    movements?: MovementSetup,
    optimizers?: OptimizationSetup,
    moveSettings: MovementOptions = DEFAULT_MOVEMENT_OPTS,
    pathfinderSettings: PathfinderOptions = DEFAULT_PATHFINDER_OPTS
  ) {
    this.world = new CacheSyncWorld(bot, this.bot.world)

    // set up executors, map them to providers.
    const moves = new Map<BuildableMoveProvider, MovementExecutor>()
    for (const [providerType, ExecutorType] of movements ?? DEFAULT_SETUP) {
      moves.set(providerType, new ExecutorType(bot, this.world, moveSettings))
    }

    // set up optimizers, map them to providers.
    const opts = new Map<BuildableMoveProvider, MovementOptimizer>()
    for (const [providerType, ExecutorType] of optimizers ?? DEFAULT_OPTIMIZATION) {
      opts.set(providerType, new ExecutorType(bot, this.world))
    }
    this.movements = moves
    this.optimizers = opts
    this.defaultMoveSettings = moveSettings
    this.pathfinderSettings = pathfinderSettings
    this.astar = null

    this.setupListeners()
  }

  async cancel (): Promise<void> {
    this.userAborted = true
    await this.interrupt(1000, true)
  }

  async interrupt (timeout = 1000, cancelCalculation = true, reasonStr?: ResetReason): Promise<void> {
    console.log('INTERRUPT CALLED')
    if (this._currentProducer == null) return console.log('no producer')
    this.abortCalculation = cancelCalculation

    if (this.currentExecutor == null) return console.log('no executor')
    // if (this.currentExecutor.aborted) return console.trace('already aborted')
    if (this.currentMove == null) throw new Error('No current move, but there is a current executor.')

    let reason
    if (reasonStr != null) {
      switch (reasonStr) {
        case 'blockUpdate':
          reason = new ResetError('blockUpdate')
          break
        case 'chunkLoad':
          reason = new ResetError('chunkLoad')
          break
        case 'goalUpdated':
          reason = new ResetError('goalUpdated')
          break
      }
    }
    this.resetReason = reasonStr
    await this.currentExecutor.abort(this.currentMove, { timeout, reason })

    // calling cleanupAll is not necessary as the end of goto already calls it.
  }

  async reset (reason: ResetReason, cancelTimeout = 1000): Promise<void> {
    this.bot.emit('resetPath', reason)
    await this.interrupt(cancelTimeout, false, reason)
  }

  setupListeners (): void {
    // this can be done once.
    this.bot.on('blockUpdate', (oldblock, newBlock: Block | null) => {
      if (oldblock == null || newBlock == null) return

      // console.log('checking', oldblock.position, newBlock.type)
      if (this.isPositionNearPath(oldblock.position, this.currentExecutingPath) && oldblock.type !== newBlock.type) {
        // console.log('hi', oldblock.type, newBlock.type)
        void this.reset('blockUpdate')
      }
    })

    this.bot.on('chunkColumnLoad', (chunk) => {
      const astarContext = this.currentAStar
      if (astarContext == null) return
      const cx = chunk.x >> 4
      const cz = chunk.z >> 4
      if (
        astarContext.visitedChunks.has(`${cx - 1},${cz}`) ||
        astarContext.visitedChunks.has(`${cx},${cz - 1}`) ||
        astarContext.visitedChunks.has(`${cx + 1},${cz}`) ||
        astarContext.visitedChunks.has(`${cx},${cz + 1}`)
      ) {
        void this.reset('chunkLoad')
      }
    })
  }

  /**
   * Gen here, I don't like this code. this is temporary.
   * Taken from: https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d69a02904bc83f4c36598ae90d470a009a130105/index.js#L237
   */
  isPositionNearPath (pos: Vec3 | undefined, path: Move[] | undefined = this.currentExecutingPath): boolean {
    // console.log('pos:', pos, 'path:', path?.length)

    const placements = path?.map((move) => move.toPlace.map((p) => p.vec.toString())).flat()
    const breaks = path?.map((move) => move.toBreak.map((b) => b.vec.toString())).flat()

    const all = new Set(placements?.concat(breaks ?? []))

    if (pos == null || path == null) return false

    for (const move of path) {
      let comparisonPoint: Vec3 | null = null

      comparisonPoint = this.closestPointOnLineSegment(pos, move.entryPos, move.exitPos)

      const dx = Math.abs(comparisonPoint.x - pos.x - 0.5)
      const dy = Math.abs(comparisonPoint.y - pos.y - 0.5)
      const dz = Math.abs(comparisonPoint.z - pos.z - 0.5)

      // console.log(comparisonPoint, dx, dy, dz, pos)
      if (dx <= 1 && dy <= 2 && dz <= 1) {
        if (!all.has(pos.floored().toString())) return true
      }
    }

    return false
  }

  /**
   * Gen here, this code is alright.
   * Taken from: https://github.com/PrismarineJS/mineflayer-pathfinder/blob/d69a02904bc83f4c36598ae90d470a009a130105/index.js#L285
   */
  closestPointOnLineSegment (point: Vec3, segmentStart: Vec3, segmentEnd: Vec3): Vec3 {
    const segmentLength = segmentEnd.minus(segmentStart).norm()

    if (segmentLength === 0) {
      return segmentStart
    }

    // given the start and end segment of a line that is of arbitrary length,
    // identify the closest point on the line to the given point.

    const t = point.minus(segmentStart).dot(segmentEnd.minus(segmentStart)) / segmentLength ** 2

    if (t < 0) {
      return segmentStart
    }

    if (t > 1) {
      return segmentEnd
    }

    return segmentStart.plus(segmentEnd.minus(segmentStart).scaled(t))
  }

  getCacheSize (): string {
    return this.world.getCacheSize()
  }

  setCacheEnabled (enabled: boolean): void {
    this.world.setEnabled(enabled)
  }

  isCacheEnabled (): boolean {
    return this.world.enabled
  }

  dropMovment (provider: BuildableMoveProvider): void {
    this.movements.delete(provider)

    // will keep in optimizers as that has no effect.
    // this.optimizers.delete(provider);
  }

  setExecutor (provider: BuildableMoveProvider, Executor: BuildableMoveExecutor | MovementExecutor): void {
    if (Executor instanceof MovementExecutor) {
      this.movements.set(provider, Executor)
    } else {
      this.movements.set(provider, new Executor(this.bot, this.world, this.defaultMoveSettings))
    }
  }

  setOptimizer (provider: BuildableMoveProvider, Optimizer: BuildableOptimizer | MovementOptimizer): void {
    if (Optimizer instanceof MovementOptimizer) {
      this.optimizers.set(provider, Optimizer)
    } else {
      this.optimizers.set(provider, new Optimizer(this.bot, this.world))
    }
  }

  setDefaultMoveOptions (settings: Partial<MovementOptions>): void {
    this.defaultMoveSettings = Object.assign({}, DEFAULT_MOVEMENT_OPTS, settings)
    for (const [, executor] of this.movements) {
      executor.settings = this.defaultMoveSettings
    }
  }

  setPathfinderOptions (settings: Partial<PathfinderOptions>): void {
    this.pathfinderSettings = Object.assign({}, DEFAULT_PATHFINDER_OPTS, settings)
  }

  getPathTo (goal: goals.Goal, settings = this.defaultMoveSettings): PathGenerator {
    return this.getPathFromTo(this.bot.entity.position, this.bot.entity.velocity, goal, settings)
  }

  getScaffoldCount (): number {
    const amt = this.bot.inventory
      .items()
      .reduce((acc, item) => (BlockInfo.scaffoldingBlockItems.has(item.type) ? item.count + acc : acc), 0)
    if (this.bot.game.gameMode === 'creative') {
      return amt > 0 ? Infinity : 0
    }
    return amt
  }

  private registerAll (
    goal: goals.GoalDynamic,
    opts: { onHasUpdate?: () => void, onInvalid?: () => void, onCleanup?: () => void, forAll?: () => void }
  ): () => void {
    const boundEvent = goal._hasChanged.bind(goal)
    const boundValid = goal.isValid.bind(goal)

    const fuckEvent: Array<[keyof BotEvents, (...args: Parameters<BotEvents[keyof BotEvents]>) => void]> = []
    const fuckValid: Array<[keyof BotEvents, (...args: Parameters<BotEvents[keyof BotEvents]>) => void]> = []

    const newOnHasUpdate = (): void => {
      if (opts.onHasUpdate != null) opts.onHasUpdate()
      if (opts.forAll != null) opts.forAll()
      for (const [key, val] of fuckEvent) {
        this.bot.off(key, val)
      }

      // clear other listeners as well.
      for (const [key, val] of fuckValid) {
        this.bot.off(key, val)
      }
    }
    const newOnInvalid = (): void => {
      if (opts.onInvalid != null) opts.onInvalid()
      if (opts.forAll != null) opts.forAll()
      for (const [key, val] of fuckValid) {
        this.bot.off(key, val)
      }

      // clear other listeners as well.
      for (const [key, val] of fuckEvent) {
        this.bot.off(key, val)
      }
    }

    const cleanup = (): void => {
      if (opts.onCleanup != null) opts.onCleanup()
      if (opts.forAll != null) opts.forAll()
      for (const [key, val] of fuckValid) {
        this.bot.off(key, val)
      }

      for (const [key, val] of fuckEvent) {
        this.bot.off(key, val)
      }
    }

    for (const key of goal._eventKeys) {
      const listener = (...args: Parameters<BotEvents[keyof BotEvents]>): void => {
        if (this.userAborted) return cleanup()
        if (boundEvent(key, ...args)) newOnHasUpdate()
      }
      this.bot.on(key, listener)
      fuckEvent.push([key, listener])
    }

    for (const key of goal._validKeys) {
      const listener1 = (...args: Parameters<BotEvents[keyof BotEvents]>): void => {
        if (this.userAborted) return cleanup()
        if (boundValid(key, ...args)) newOnInvalid()
      }
      this.bot.on(key, listener1)
      fuckValid.push([key, listener1])
    }

    // potential bug fixed with this.
    goal.cleanup = cleanup

    return cleanup
  }

  async * getPathFromTo (startPos: Vec3, startVel: Vec3, goal: goals.Goal, settings = this.defaultMoveSettings): PathGenerator {
    this.abortCalculation = false
    delete this.resetReason

    this.currentMove = Move.startMove(new IdleMovement(this.bot, this.world), startPos.clone(), startVel.clone(), this.getScaffoldCount())
    this.currentExecutor = new IdleMovementExecutor(this.bot, this.world, this.defaultMoveSettings)

    // technically introducing a bug here, where resetting the pathingUtil fucks up.
    this.bot.pathingUtil.refresh()

    if (this.pathfinderSettings.partialPathProducer) {
      this._currentProducer = new PartialPathProducer(this.currentMove, goal, settings, this.bot, this.world, this.movements)
    } else {
      this._currentProducer = new ContinuousPathProducer(this.currentMove, goal, settings, this.bot, this.world, this.movements)
    }

    let ticked = false

    const listener = (): void => {
      ticked = true
    }

    const cleanup = (): void => {
      this.bot.off('physicsTick', listener)
    }

    let result, astarContext

    do {
      const res = this._currentProducer.advance()
      result = res.result
      astarContext = res.astarContext

      if (result.status === 'success') {
        cleanup()
        this.bot.emit('pathGenerated', result)
        yield { result, astarContext }
        return { result, astarContext }
      }

      if (this.abortCalculation) {
        cleanup()
        yield { result, astarContext }
        return { result, astarContext }
      }

      yield { result, astarContext }

      if (!ticked) {
        await this.bot.waitForTicks(1)
        ticked = false
      }
    } while (result.status === 'partial' || result.status === 'partialSuccess')

    cleanup()
    return {
      result,
      astarContext
    }
  }

  async getPathFromToRaw (startPos: Vec3, startVel: Vec3, goal: goals.Goal): Promise<PathInfo | null> {
    for await (const res of this.getPathFromTo(startPos, startVel, goal)) {
      if (res.result.status !== 'success') {
        if (res.result.status === 'noPath' || res.result.status === 'timeout') return null
      } else {
        return res.result
      }
    }
    return null
  }

  /**
   * @param {goals.Goal | null} goal
   */
  async goto (goal: goals.Goal, performOpts: PerformOpts = {}): Promise<void> {
    console.log('GOTO CALLED')
    if (goal == null) {
      await this.cancel()
      await this.executeTask.promise
      await this.cleanupAll(goal, this.currentExecutor)
      return
    }

    if (!this.executeTask.done) {
      console.log('cancelling others')
      this.wantedGoal = goal
      await this.cancel()
      await this.executeTask.promise
      if (this.wantedGoal !== goal) return
      delete this.wantedGoal
    }

    this.cleanupClient()
    this.executeTask = new Task()
    this.currentGotoGoal = goal
    this.bot.emit('goalSet', goal)

    const doForever = !!(goal instanceof goals.GoalDynamic && goal.neverfinish && goal.dynamic)

    let toWaitOn = Promise.resolve()
    let manualCleanup = (): void => {}

    const setupWait = (): void => {
      if (goal instanceof goals.GoalDynamic && goal.dynamic) {
        toWaitOn = new Promise((resolve) => {
          manualCleanup = this.registerAll(goal, {
            onHasUpdate: () => {
              void this.reset('goalUpdated')
            },
            onInvalid: () => {
              void this.cancel()
            },
            forAll: () => {
              console.log('cleaned up')
              resolve()
            }
          })
        })
      }
    }

    do {
      do {
        setupWait()

        for await (const res of this.getPathTo(goal)) {
          if (res.result.status !== 'success') {
            if (res.result.status === 'noPath' || res.result.status === 'timeout') break
          } else {
            const newPath = await this.postProcess(res.result)
            await this.perform(newPath, goal)

            if (performOpts.errorOnAbort != null && performOpts.errorOnAbort && this.abortCalculation) {
              throw new Error('Goto: Goal was canceled.')
            }

            if (performOpts.errorOnReset != null && performOpts.errorOnReset && this.resetReason != null) {
              throw new Error('Goto: Purposefully cancelled due to recalculation of path occurring.')
            }

            if (this.resetReason == null) {
              console.log('finished!', this.bot.entity.position, this.bot.listeners('entityMoved'), this.bot.listeners('entityGone'))
              await this.cleanupBot()
              manualCleanup()
              setupWait()
              break
            }

            console.log('resetting!', this.resetReason, this.abortCalculation, this.userAborted)
            await this.cleanupBot()
            manualCleanup()
          }
        }
      } while (this.resetReason != null && !this.abortCalculation && !this.userAborted)

      await this.cleanupBot()
      if (doForever) {
        if (this.resetReason == null && !this.userAborted) {
          await toWaitOn
        }
      }
      // eslint-disable-next-line no-unmodified-loop-condition
    } while (doForever && !this.userAborted)

    // console.log('sup gang!!1', doForever, this.userAborted, performance.now())

    manualCleanup()
    await this.cleanupAll(goal, this.currentExecutor)
  }

  private async postProcess (pathInfo: Path): Promise<Path> {
    const optimizer = new Optimizer(this.bot, this.world, this.optimizers)

    optimizer.loadPath(pathInfo.path)

    const res = await optimizer.compute()

    const ret = { ...pathInfo }

    ret.path = res
    return ret
  }

  private check (): void {
    if (this.userAborted) {
      throw new AbortError('User cancelled.')
    }

    if (this.resetReason != null) {
      throw new ResetError(this.resetReason)
    }
  }

  /**
   * Do not mind the absolutely horrendous code here right now.
   * It will be fixed, just very busy right now.
   * @param path
   * @param goal
   * @param entry
   */
  async perform (path: Path, goal: goals.Goal, entry = 0): Promise<void> {
    if (entry > 10) throw new Error('Too many failures, exiting performing.')

    let currentIndex = 0
    const movementHandler = path.context.movementProvider as MovementHandler
    const movements = movementHandler.getMovements()

    while (currentIndex < path.path.length) {
      const move = path.path[currentIndex]
      const executor = movements.get(move.moveType.constructor as BuildableMoveProvider)
      if (executor == null) throw new Error('No executor for movement type ' + move.moveType.constructor.name)

      this.currentExecutingPath = path.path
      this.currentMove = move
      this.currentExecutor = executor

      let tickCount = 0

      // TODO: could move this to physicsTick to be performant, but meh who cares.

      // reset bot.
      await this.cleanupBot()

      // provide current move to executor as a reference.
      executor.loadMove(move)

      // if the movement has already been completed (another movement has already completed it), skip it.
      if (executor.isAlreadyCompleted(move, tickCount, goal)) {
        currentIndex++
        continue
      }

      console.log('performing', move.moveType.constructor.name, 'at index', currentIndex, 'of', path.path.length)
      console.log(
        'toPlace',
        move.toPlace.map((p) => p.vec),
        'toBreak',
        move.toBreak.map((b) => b.vec),
        'entryPos',
        move.entryPos,
        'asVec',
        move.vec,
        'exitPos',
        move.exitPos
      )

      // wrap this code in a try-catch as we intentionally throw errors.
      try {
        while (!(await executor.align(move, tickCount++, goal)) && tickCount < 999) {
          this.check()
          await this.bot.waitForTicks(1)
        }

        tickCount = 0

        // allow the initial execution of this code.
        await executor._performInit(move, currentIndex, path.path)

        this.check()
        let adding = await executor._performPerTick(move, tickCount++, currentIndex, path.path)

        while (!(adding as boolean) && tickCount < 999) {
          this.check()
          await this.bot.waitForTicks(1)
          adding = await executor._performPerTick(move, tickCount++, currentIndex, path.path)
        }

        currentIndex += adding as number
        console.log('done with move', move.exitPos, this.bot.entity.position, this.bot.entity.position.distanceTo(move.exitPos))
      } catch (err) {
        // immediately exit since we want to abort the entire path.
        if (err instanceof AbortError) {
          executor.reset()
          delete this.resetReason
          return
        } else if (err instanceof ResetError) {
          executor.reset()
          return
        } else if (err instanceof CancelError) {
          // allow recovery if movement intentionall canceled.
          await this.recovery(move, path, goal, entry)
          return
        } else throw err
      }
    }
  }

  // TODO: implement recovery for any movement and goal.
  async recovery (move: Move, path: Path, goal: goals.Goal, entry = 0): Promise<void> {
    this.bot.emit('enteredRecovery', entry)
    await this.cleanupBot()
    this.cleanupClient()

    const ind = path.path.indexOf(move)
    if (ind === -1) {
      return // done
    }

    let newGoal

    const pos = this.bot.entity.position
    let bad = false
    let nextMove = path.path.sort((a, b) => a.entryPos.distanceTo(pos) - b.entryPos.distanceTo(pos))[0] as Move | undefined
    if (nextMove == null || path.path.indexOf(nextMove) < ind) {
      bad = true
    } else if (path.path.indexOf(nextMove) === ind) {
      nextMove = path.path[ind + 1]
    }

    const no = entry > 0 || bad
    if (no || nextMove == null) {
      newGoal = goal
    } else {
      newGoal = goals.GoalBlock.fromVec(nextMove.vec)
    }

    let path1 = await this.getPathFromToRaw(this.bot.entity.position, EMPTY_VEC, newGoal)

    if (path1 === null) {
      // done
      this.bot.emit('exitedRecovery', entry)
    } else if (no) {
      path1 = await this.postProcess(path1)

      // execution of past recoveries failed or not easily saveable, so full recovery needed.
      this.bot.emit('exitedRecovery', entry)
      await this.perform(path1, goal, entry + 1)
    } else {
      path1 = await this.postProcess(path1)
      // attempt recovery to nearby node.
      await this.perform(path1, newGoal, entry + 1)
      path.path.splice(0, ind + 1)

      this.bot.emit('exitedRecovery', entry)
      await this.perform(path, goal, 0)
    }
  }

  async cleanupBot (): Promise<void> {
    this.bot.clearControlStates()

    for (const [, executor] of this.movements) {
      executor.reset()
    }
    // await this.bot.waitForTicks(1);
  }

  cleanupClient (): void {
    this.abortCalculation = false
    this.userAborted = false

    delete this.resetReason

    delete this.currentGotoGoal
    delete this.currentExecutingPath
    delete this.currentMove
    delete this.currentExecutor
  }

  async cleanupAll (goal: goals.Goal, lastMove?: MovementExecutor): Promise<void> {
    if (goal instanceof goals.GoalDynamic && goal.dynamic) {
      goal.cleanup?.()
    }

    await this.cleanupBot()
    if (lastMove != null && !this.abortCalculation) await goal.onFinish(lastMove)
    await this.cleanupBot()
    this.bot.chat(this.world.getCacheSize())
    this.world.clearCache()

    console.log('CLEANUP CALLED')

    if (this.userAborted) this.bot.emit('goalAborted', goal)
    else this.bot.emit('goalFinished', goal)

    this.abortCalculation = false
    this.userAborted = false
    this.executeTask.finish()

    this.cleanupClient()
  }
}
