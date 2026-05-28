import { clamp } from './geo';

type Matrix4 = number[][];

const identity4 = (): Matrix4 => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export class ConstantVelocityKalmanFilter {
  private state: [number, number, number, number] = [0, 0, 0, 0];

  private covariance: Matrix4 = identity4().map((row) => row.map((value) => value * 1000));

  private initialized = false;

  reset(positionM: [number, number], velocityMps: [number, number] = [0, 0]): void {
    this.state = [positionM[0], positionM[1], velocityMps[0], velocityMps[1]];
    this.covariance = [
      [25, 0, 0, 0],
      [0, 25, 0, 0],
      [0, 0, 16, 0],
      [0, 0, 0, 16],
    ];
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  predict(dtSeconds: number, accelerationNoiseMps2: number): void {
    if (!this.initialized) {
      return;
    }

    const dt = clamp(dtSeconds, 0.016, 3);
    this.state = [
      this.state[0] + this.state[2] * dt,
      this.state[1] + this.state[3] * dt,
      this.state[2],
      this.state[3],
    ];

    const p = this.covariance;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q = Math.max(0.2, accelerationNoiseMps2);
    const q2 = q * q;
    const process = [
      [0.25 * dt4 * q2, 0, 0.5 * dt3 * q2, 0],
      [0, 0.25 * dt4 * q2, 0, 0.5 * dt3 * q2],
      [0.5 * dt3 * q2, 0, dt2 * q2, 0],
      [0, 0.5 * dt3 * q2, 0, dt2 * q2],
    ];

    const predicted: Matrix4 = identity4().map(() => [0, 0, 0, 0]);
    const f = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];

    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        let value = 0;
        for (let k = 0; k < 4; k += 1) {
          for (let l = 0; l < 4; l += 1) {
            value += f[row][k] * p[k][l] * f[col][l];
          }
        }
        predicted[row][col] = value + process[row][col];
      }
    }

    this.covariance = predicted;
  }

  update(measurementM: [number, number], measurementAccuracyM: number): void {
    if (!this.initialized) {
      this.reset(measurementM);
      return;
    }

    const variance = Math.pow(clamp(measurementAccuracyM, 3, 160), 2);
    const innovationX = measurementM[0] - this.state[0];
    const innovationY = measurementM[1] - this.state[1];
    const p = this.covariance;
    const s00 = p[0][0] + variance;
    const s01 = p[0][1];
    const s10 = p[1][0];
    const s11 = p[1][1] + variance;
    const det = s00 * s11 - s01 * s10;

    if (Math.abs(det) < Number.EPSILON) {
      return;
    }

    const invS00 = s11 / det;
    const invS01 = -s01 / det;
    const invS10 = -s10 / det;
    const invS11 = s00 / det;
    const gain = [0, 1, 2, 3].map((row) => [
      p[row][0] * invS00 + p[row][1] * invS10,
      p[row][0] * invS01 + p[row][1] * invS11,
    ]);

    this.state = [
      this.state[0] + gain[0][0] * innovationX + gain[0][1] * innovationY,
      this.state[1] + gain[1][0] * innovationX + gain[1][1] * innovationY,
      this.state[2] + gain[2][0] * innovationX + gain[2][1] * innovationY,
      this.state[3] + gain[3][0] * innovationX + gain[3][1] * innovationY,
    ];

    const next: Matrix4 = identity4().map(() => [0, 0, 0, 0]);
    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        next[row][col] = p[row][col] - gain[row][0] * p[0][col] - gain[row][1] * p[1][col];
      }
    }
    this.covariance = next;
  }

  getPosition(): [number, number] {
    return [this.state[0], this.state[1]];
  }

  getVelocity(): [number, number] {
    return [this.state[2], this.state[3]];
  }
}
