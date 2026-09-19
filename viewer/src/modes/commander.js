// Commander mode: orbit the replay on an iPad or laptop. No portal, no camera feed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function setupCommander({ renderer, scene, camera, sceneRoot, data, alignmentCloud }) {
  scene.background = new THREE.Color(0x0b0f14);
  renderer.setClearAlpha(1);

  const floorY = data.floorY ?? data.static.bounds.min[1];
  const { min, max } = data.static.bounds;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;

  // floor grid at floor_y, 0.5 m cells
  const span = Math.ceil(Math.max(max[0] - min[0], Math.abs(min[2]) + 1, 6) / 2) * 2 + 4;
  const grid = new THREE.GridHelper(span, span * 2, 0x3a5068, 0x1c2836);
  grid.position.set(cx, floorY - 0.005, cz);
  sceneRoot.add(grid);

  // the jig (origin) and its facing direction
  const jig = new THREE.AxesHelper(0.4);
  sceneRoot.add(jig);

  // faint outline of the wall plane the alignment happens against
  if (data.wallZ !== null) {
    const yTop = Math.max(max[1], floorY + 2.4);
    const pts = [
      new THREE.Vector3(min[0], floorY, data.wallZ),
      new THREE.Vector3(max[0], floorY, data.wallZ),
      new THREE.Vector3(max[0], yTop, data.wallZ),
      new THREE.Vector3(min[0], yTop, data.wallZ),
    ];
    const wall = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5c7590, transparent: true, opacity: 0.6 }),
    );
    sceneRoot.add(wall);
  }

  // the recorded outside of the wall is context here, so show it dimmed
  if (alignmentCloud) alignmentCloud.uniforms.uBrightness.value = 0.45;

  // stand behind the jig looking into the room
  const target = new THREE.Vector3(cx, floorY + 1.0, (data.wallZ ?? cz) - 1.2);
  camera.position.set(0.6, floorY + 2.6, 3.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.3;
  controls.maxDistance = 40;
  controls.update();

  let topDown = false;
  let saved = null;
  const toggleTopDown = () => {
    topDown = !topDown;
    if (topDown) {
      saved = { position: camera.position.clone(), target: controls.target.clone() };
      controls.target.set(cx, floorY, cz);
      camera.position.set(cx, floorY + 10, cz + 0.001);
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = 0.001;
    } else {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI;
      if (saved) {
        camera.position.copy(saved.position);
        controls.target.copy(saved.target);
      }
    }
    controls.update();
    return topDown;
  };

  return {
    name: 'commander',
    toggleTopDown,
    update() {
      controls.update();
    },
  };
}
