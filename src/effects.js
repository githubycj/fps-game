// ===== 战斗特效：发光曳光弹束、枪口闪光、撞击火花 =====
import * as THREE from 'three';

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.tracers = [];
    this.lights = [];
    this.flashes = [];
    this.sparks = [];
  }

  // 发光弹束：沿射线方向拉伸的半透明加色圆柱
  tracer(from, to, color = 0x7fd4ff) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    if (len < 0.01) return;
    const geo = new THREE.CylinderGeometry(0.022, 0.022, len, 5, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const beam = new THREE.Mesh(geo, mat);
    beam.position.copy(from).addScaledVector(dir, 0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    this.scene.add(beam);
    this.tracers.push({ beam, life: 0.12, max: 0.12 });
    // 头部亮点
    this.addFlash(to, color, 0.06, 0.1);
  }

  // 枪口闪光：点光源 + 发光小球
  muzzleFlash(pos, color = 0x7fd4ff) {
    const light = new THREE.PointLight(color, 8, 9);
    light.position.copy(pos);
    this.scene.add(light);
    this.lights.push({ light, life: 0.06, max: 0.06 });
    this.addFlash(pos, color, 0.14, 0.07);
  }

  // 撞击：火花 + 短暂发光点
  impact(pos, color = 0x7fd4ff) {
    const n = 14;
    const positions = new Float32Array(n * 3);
    const vels = [];
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      vels.push(new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        Math.random() * 7,
        (Math.random() - 0.5) * 8
      ));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color, size: 0.11, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    this.sparks.push({ pts, vels, life: 0.4, max: 0.4 });
    this.addFlash(pos, color, 0.12, 0.12);
  }

  // 通用发光点
  addFlash(pos, color, size, life) {
    const geo = new THREE.SphereGeometry(size, 6, 6);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const s = new THREE.Mesh(geo, mat);
    s.position.copy(pos);
    this.scene.add(s);
    this.flashes.push({ s, life, max: life });
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.beam.material.opacity = Math.max(0, (t.life / t.max) * 0.9);
      if (t.life <= 0) {
        this.scene.remove(t.beam);
        t.beam.geometry.dispose();
        t.beam.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.lights.length - 1; i >= 0; i--) {
      const l = this.lights[i];
      l.life -= dt;
      l.light.intensity = Math.max(0, (l.life / l.max)) * 8;
      if (l.life <= 0) {
        this.scene.remove(l.light);
        this.lights.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      f.s.material.opacity = Math.max(0, (f.life / f.max) * 0.9);
      f.s.scale.setScalar(1 + (1 - f.life / f.max) * 1.5);
      if (f.life <= 0) {
        this.scene.remove(f.s);
        f.s.geometry.dispose();
        f.s.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.life -= dt;
      const attr = s.pts.geometry.attributes.position;
      const arr = attr.array;
      for (let j = 0; j < s.vels.length; j++) {
        s.vels[j].y -= 14 * dt;
        arr[j * 3] += s.vels[j].x * dt;
        arr[j * 3 + 1] += s.vels[j].y * dt;
        arr[j * 3 + 2] += s.vels[j].z * dt;
      }
      attr.needsUpdate = true;
      s.pts.material.opacity = Math.max(0, s.life / s.max);
      if (s.life <= 0) {
        this.scene.remove(s.pts);
        s.pts.geometry.dispose();
        s.pts.material.dispose();
        this.sparks.splice(i, 1);
      }
    }
  }
}