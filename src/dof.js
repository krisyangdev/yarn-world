// Depth of field that reuses the depth buffer from the scene render instead of drawing the
// scene a second time like three's BokehPass. The composer's render targets must carry a
// DepthTexture (see makeDepthTarget).
// Unlike stock BokehShader, everything within ±focusRange × focus of the focal plane stays fully
// sharp, like a real lens's depth of field, so a subject and its neighbours read crisp together.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BokehShader } from 'three/addons/shaders/BokehShader.js';

export function makeDepthTarget(width, height) {
	return new THREE.WebGLRenderTarget(width, height, {
		type: THREE.HalfFloatType,
		depthTexture: new THREE.DepthTexture(width, height),
	});
}

export class DofPass extends Pass {
	constructor(camera, { focus = 10, aperture = 0.001, maxblur = 0.005, focusRange = 0.2 } = {}) {
		super();
		this.camera = camera;
		this.uniforms = THREE.UniformsUtils.clone(BokehShader.uniforms);
		this.uniforms.focus.value = focus;
		this.uniforms.aperture.value = aperture;
		this.uniforms.maxblur.value = maxblur;
		this.uniforms.focusRange = { value: focusRange };
		this.material = new THREE.ShaderMaterial({
			defines: { ...BokehShader.defines, DEPTH_PACKING: 0 },
			uniforms: this.uniforms,
			vertexShader: BokehShader.vertexShader,
			fragmentShader: BokehShader.fragmentShader
				.replace('uniform float focus;', 'uniform float focus;\nuniform float focusRange;')
				.replace(
					'float factor = ( focus + viewZ );',
					'float factor = focus + viewZ;\nfactor = sign( factor ) * max( abs( factor ) - focus * focusRange, 0.0 );',
				),
		});
		this._quad = new FullScreenQuad(this.material);
	}

	setSize(width, height) {
		this.uniforms.aspect.value = width / height;
	}

	render(renderer, writeBuffer, readBuffer) {
		this.uniforms.tColor.value = readBuffer.texture;
		this.uniforms.tDepth.value = readBuffer.depthTexture;
		this.uniforms.nearClip.value = this.camera.near;
		this.uniforms.farClip.value = this.camera.far;
		renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
		this._quad.render(renderer);
	}

	dispose() {
		this.material.dispose();
		this._quad.dispose();
	}
}
