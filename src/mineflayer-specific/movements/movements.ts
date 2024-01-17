import { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { goals } from "../goals";
import { Move } from "../move";
import { World } from "../world/worldInterface";
import { Movement, MovementOptions } from "./movement";
import { CancelError } from "./exceptions";
import { BlockInfo } from "../world/cacheWorld";
import { BreakHandler, PlaceHandler } from "./utils";

export class IdleMovement extends Movement {
  provideMovements(start: Move, storage: Move[]): void {}
  performInit = async (thisMove: Move, goal: goals.Goal) => {};
  performPerTick = async (thisMove: Move, tickCount: number, goal: goals.Goal) => {
    return true;
  };
}

export class ForwardMove extends Movement {
  constructor(bot: Bot, world: World, settings: Partial<MovementOptions>) {
    super(bot, world, settings);
  }

  provideMovements(start: Move, storage: Move[], goal: goals.Goal): void {
    for (const dir of Movement.cardinalDirs) {
      this.getMoveForward(start, dir, storage);
    }
  }

  performInit = async (thisMove: Move, goal: goals.Goal) => {
    await this.bot.lookAt(thisMove.exitPos, true);

    for (const place of thisMove.toPlace) {
      await this.performInteraction(place);
    }

    for (const breakH of thisMove.toBreak) {
      await this.performInteraction(breakH);
    }
  };

  performPerTick = (thisMove: Move, tickCount: number, goal: goals.Goal) => {
    if (this.cI && !this.cI.allowExternalInfluence(this.bot)) {
      this.bot.clearControlStates();
      return false;
    }


    if (tickCount > 40) throw new CancelError("ForwardMove: tickCount > 40");
    if (!this.bot.entity.onGround) throw new CancelError("ForwardMove: not on ground");

    this.bot.lookAt(thisMove.exitPos, true);

    if (this.bot.entity.position.distanceTo(thisMove.exitPos) < 0.2) return true;

    this.bot.setControlState("forward", true);
    if (this.bot.food <= 6) this.bot.setControlState("sprint", false);
    else this.bot.setControlState("sprint", true);
    return false;
  };

  getMoveForward(start: Move, dir: Vec3, neighbors: Move[]) {
    const pos = start.toVec();

    const blockB = this.getBlockInfo(pos, dir.x, 1, dir.z);
    const blockC = this.getBlockInfo(pos, dir.x, 0, dir.z);
    const blockD = this.getBlockInfo(pos, dir.x, -1, dir.z);

    let cost = 1; // move cost

    if (!blockD.physical) {
      // block at feet in front of us is air
      return;
    }

    if (blockB.physical || blockC.physical) {
      return;
    }

    // set exitPos to center of wanted block
    neighbors.push(Move.fromPrevious(cost, pos.add(dir).translate(0.5, 0.5, 0.5), start, this));
  }
}

export class ForwardJumpMove extends Movement {
  provideMovements(start: Move, storage: Move[], goal: goals.Goal): void {
    for (const dir of Movement.cardinalDirs) {
      this.getMoveJumpUp(start, dir, storage);
    }
  }

  performInit = async (thisMove: Move, goal: goals.Goal) => {
    await this.bot.lookAt(thisMove.exitPos, true);
    this.bot.setControlState("jump", true);
    this.bot.setControlState("forward", true);
    this.bot.setControlState("sprint", false);

    for (const place of thisMove.toPlace) {
      await this.performInteraction(place);
    }

    for (const breakH of thisMove.toBreak) {
      await this.performInteraction(breakH);
    }
  };

  performPerTick = (thisMove: Move, tickCount: number, goal: goals.Goal) => {
    if (this.cI && !this.cI.allowExternalInfluence(this.bot)) {
      this.bot.clearControlStates();
      return false;
    }

    this.bot.lookAt(thisMove.exitPos, true);

    if (tickCount > 40) throw new CancelError("ForwardJumpMove: tickCount > 40");
    if (this.bot.entity.position.y - thisMove.exitPos.y < -1) throw new CancelError("ForwardJumpMove: too low");

    if (tickCount > 0 && this.bot.entity.onGround) {
      this.bot.setControlState("jump", false);
      this.bot.setControlState("sprint", true);
      if (this.bot.entity.position.y - thisMove.exitPos.y < 0) throw new CancelError("ForwardJumpMove: too low");
      if (this.bot.entity.position.xzDistanceTo(thisMove.exitPos) < 0.3) return true;
    }

    return false;
  };

  /**
   * TODO: provide both non-sprint and sprint-jump moves here.
   * Saves time.
   * @param node
   * @param dir
   * @param neighbors
   * @returns
   */
  getMoveJumpUp(node: Move, dir: Vec3, neighbors: Move[]) {
    // const pos = node.exitRounded(1)
    const pos = node.toVec();
    const blockA = this.getBlockInfo(pos, 0, 2, 0);
    const blockH = this.getBlockInfo(pos, dir.x, 2, dir.z);
    const blockB = this.getBlockInfo(pos, dir.x, 1, dir.z);
    const blockC = this.getBlockInfo(pos, dir.x, 0, dir.z);

    let cost = 2; // move cost (move+jump)
    const toBreak = [];
    const toPlace = [];

    let cHeight = blockC.height;

    // if (blockA.physical && (this.getNumEntitiesAt(blockA.position, 0, 1, 0) > 0)) return // Blocks A, B and H are above C, D and the player's space, we need to make sure there are no entities that will fall down onto our building space if we break them
    // if (blockH.physical && (this.getNumEntitiesAt(blockH.position, 0, 1, 0) > 0)) return
    // if (blockB.physical && !blockH.physical && !blockC.physical && (this.getNumEntitiesAt(blockB.position, 0, 1, 0) > 0)) return // It is fine if an ent falls on B so long as we don't need to replace block C

    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      // if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

      const blockD = this.getBlockInfo(pos, dir.x, -1, dir.z);
      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return // not enough blocks to place

        // if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

        if (!blockD.replaceable) {
          if (!this.safeToBreak(blockD)) return;
          // cost += this.exclusionBreak(blockD)
          toBreak.push(BreakHandler.fromVec(blockD.position, "solid"));
        }
        // cost += this.exclusionPlace(blockD)
        toPlace.push(PlaceHandler.fromVec(blockD.position, "solid"));
        // cost += this.placeCost // additional cost for placing a block
      }

      if (!blockC.replaceable) {
        if (!this.safeToBreak(blockC)) return;
        // cost += this.exclusionBreak(blockC)
        toBreak.push(BreakHandler.fromVec(blockC.position, "solid"));
      }
      // cost += this.exclusionPlace(blockC)
      toPlace.push(PlaceHandler.fromVec(blockC.position, "solid"));
      // cost += this.placeCost // additional cost for placing a block

      cHeight += 1;
    }

    const block0 = this.getBlockInfo(pos, 0, -1, 0);
    if (cHeight - block0.height > 1.2) return; // Too high to jump

    cost += this.safeOrBreak(blockA, toBreak);
    if (cost > 100) return;
    cost += this.safeOrBreak(blockH, toBreak);
    if (cost > 100) return;
    cost += this.safeOrBreak(blockB, toBreak);
    if (cost > 100) return;

    // set exitPos to center of block we want.
    neighbors.push(Move.fromPrevious(cost, blockB.position.offset(0.5, 0.5, 0.5), node, this, toPlace, toBreak));
  }
}