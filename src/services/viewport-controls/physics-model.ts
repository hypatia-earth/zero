/**
 * Physics Model
 *
 * Handles physics simulation for camera rotation:
 * - Inertia model: force → acceleration → velocity → position
 * - Velocity model: direct velocity with speed-dependent friction
 *
 * Uses geographic coordinates (lat/lon in degrees)
 */

export interface InertiaConfig {
  mass: number;
  friction: number;
  fingerFriction: number;
}

export interface VelocityConfig {
  baseFriction: number;
  maxFriction: number;
  frictionScale: number;
  minVelocity: number;
  maxVelocity: number;
}

export interface ZoomConfig {
  dampingFactor: number;
}

export interface PhysicsState {
  lat: number;
  lon: number;
  distance: number;
  latVelocity: number;
  lonVelocity: number;
  latForce: number;
  lonForce: number;
  targetDistance: number;
}

export interface PhysicsUpdateResult {
  wasMoving: boolean;
  nowStopped: boolean;
}

export class PhysicsModel {
  // Geographic coordinates (degrees)
  public lat: number = 0;
  public lon: number = 0;
  public distance: number = 3.0;
  public targetDistance: number = 3.0;

  // Velocities (degrees per second)
  public latVelocity: number = 0;
  public lonVelocity: number = 0;

  // Forces (for inertia model)
  public latForce: number = 0;
  public lonForce: number = 0;

  // Time scroll momentum (hours per second)
  public timeVelocity: number = 0;

  constructor(
    private latMin: number = -89,
    private latMax: number = 89
  ) {}

  /**
   * Initialize from camera state
   */
  initFromCamera(lat: number, lon: number, distance: number): void {
    this.lat = lat;
    this.lon = lon;
    this.distance = distance;
    this.targetDistance = distance;
  }

  /**
   * Run physics update for inertia model
   */
  updateInertia(
    deltaTime: number,
    config: InertiaConfig,
    isDragging: boolean
  ): PhysicsUpdateResult {
    const mass = config.mass;

    // Apply finger friction: extra friction while dragging
    const baseFriction = config.friction;
    const friction = isDragging
      ? baseFriction + (1 - baseFriction) * (1 - config.fingerFriction)
      : baseFriction;

    // Acceleration = force / mass
    const latAccel = this.latForce / mass;
    const lonAccel = this.lonForce / mass;

    // Integrate: velocity += acceleration * dt
    this.latVelocity += latAccel * deltaTime;
    this.lonVelocity += lonAccel * deltaTime;

    // Reset forces (they're applied per-frame from input)
    this.latForce = 0;
    this.lonForce = 0;

    // Apply friction as velocity damping
    const frictionFactor = Math.pow(1 - friction, deltaTime * 60);
    this.latVelocity *= frictionFactor;
    this.lonVelocity *= frictionFactor;

    // Track movement state
    const minVel = 0.0001;
    const wasMoving = Math.abs(this.latVelocity) >= minVel || Math.abs(this.lonVelocity) >= minVel;

    if (Math.abs(this.latVelocity) < minVel) this.latVelocity = 0;
    if (Math.abs(this.lonVelocity) < minVel) this.lonVelocity = 0;

    const nowStopped = this.latVelocity === 0 && this.lonVelocity === 0;

    return { wasMoving, nowStopped };
  }

  /**
   * Run physics update for velocity model
   */
  updateVelocity(config: VelocityConfig): PhysicsUpdateResult {
    const speed = Math.sqrt(
      this.latVelocity * this.latVelocity + this.lonVelocity * this.lonVelocity
    );
    const baseFriction = config.baseFriction;
    const maxFriction = config.maxFriction;
    const frictionScale = config.frictionScale;
    const friction = maxFriction - (maxFriction - baseFriction) * (1 - Math.exp(-speed * frictionScale));

    this.latVelocity *= friction;
    this.lonVelocity *= friction;

    const minVel = config.minVelocity;
    const wasMoving = Math.abs(this.latVelocity) >= minVel || Math.abs(this.lonVelocity) >= minVel;

    if (Math.abs(this.latVelocity) < minVel) this.latVelocity = 0;
    if (Math.abs(this.lonVelocity) < minVel) this.lonVelocity = 0;

    const nowStopped = this.latVelocity === 0 && this.lonVelocity === 0;

    return { wasMoving, nowStopped };
  }

  /**
   * Apply angular velocity to position
   */
  applyVelocity(deltaTime: number): void {
    this.lat += this.latVelocity * deltaTime;
    this.lon += this.lonVelocity * deltaTime;

    // Normalize lon to [-180, 180]
    while (this.lon > 180) this.lon -= 360;
    while (this.lon < -180) this.lon += 360;

    // Clamp lat
    this.lat = Math.max(this.latMin, Math.min(this.latMax, this.lat));
  }

  /**
   * Apply zoom damping
   */
  applyZoomDamping(dampingFactor: number): void {
    this.distance += (this.targetDistance - this.distance) * dampingFactor;
  }

  /**
   * Apply time scroll momentum
   * Returns hours delta to apply, or 0 if no momentum
   */
  applyTimeMomentum(deltaTime: number): number {
    if (Math.abs(this.timeVelocity) <= 0.001) {
      return 0;
    }

    const hoursDelta = this.timeVelocity * deltaTime;

    // Apply friction
    const friction = 0.93;
    this.timeVelocity *= Math.pow(friction, deltaTime * 60);
    if (Math.abs(this.timeVelocity) < 0.001) this.timeVelocity = 0;

    return hoursDelta;
  }

  /**
   * Stop all velocities
   */
  stopVelocities(): void {
    this.latVelocity = 0;
    this.lonVelocity = 0;
  }

  /**
   * Get current state
   */
  getState(): PhysicsState {
    return {
      lat: this.lat,
      lon: this.lon,
      distance: this.distance,
      latVelocity: this.latVelocity,
      lonVelocity: this.lonVelocity,
      latForce: this.latForce,
      lonForce: this.lonForce,
      targetDistance: this.targetDistance,
    };
  }

  /**
   * Set state (for animations)
   */
  setState(state: Partial<PhysicsState>): void {
    if (state.lat !== undefined) this.lat = state.lat;
    if (state.lon !== undefined) this.lon = state.lon;
    if (state.distance !== undefined) this.distance = state.distance;
    if (state.latVelocity !== undefined) this.latVelocity = state.latVelocity;
    if (state.lonVelocity !== undefined) this.lonVelocity = state.lonVelocity;
    if (state.latForce !== undefined) this.latForce = state.latForce;
    if (state.lonForce !== undefined) this.lonForce = state.lonForce;
    if (state.targetDistance !== undefined) this.targetDistance = state.targetDistance;
  }
}
