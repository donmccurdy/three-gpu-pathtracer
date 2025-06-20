import {
	WebGLRenderer,
	PerspectiveCamera,
	Scene,
	PointLight,
	AmbientLight,
	WebGLRenderTarget,
	FloatType,
	RGBAFormat,
	Group,
	Box3,
	Sphere,
	MeshPhysicalMaterial,
	EquirectangularReflectionMapping,
	MeshBasicMaterial,
	NoColorSpace,
	NearestFilter,
	LinearMipmapLinearFilter
} from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { AOThicknessMapGenerator } from '../src/utils/AOThicknessMapGenerator.js';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsVolume } from '@gltf-transform/extensions';
import { unwrap, cloneDocument } from '@gltf-transform/functions';
import { DocumentView } from '@gltf-transform/view';
import * as watlas from 'watlas';

const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aristea_wreck_puresky_2k.hdr';

let renderer, camera, scene, stats;
let statusEl, totalSamples = 0;
let aoGenerator, aoTarget, aoTexture, gui, aoMaterial;
let background;
let quad;
let io, sourceDocument;

const params = {
	transmission: false,
	displayMap: false,
};

const TEXTURE_SIZE = 1024;
const TEXTURE_CHANNEL = 2;
const MAX_SAMPLES = 50;

init();

async function init() {

	// initialize renderer
	renderer = new WebGLRenderer( { antialias: true } );
	renderer.setClearColor( 0x111111 );
	document.body.appendChild( renderer.domElement );

	camera = new PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 200 );
	camera.position.set( - 4, 2, 3 );

	scene = new Scene();
	scene.backgroundRotation.set( 0, 0.75, 0 );
	scene.backgroundBlurriness = 0.1;

	const light1 = new PointLight( 0xaaaaaa, 20, 100 );
	light1.position.set( 3, 3, 3 );

	const light2 = new PointLight( 0xaaaaaa, 20, 100 );
	light2.position.set( - 3, - 3, - 3 );

	const ambientLight = new AmbientLight( 0xffffff, 2.75 );
	scene.add( ambientLight );

	new OrbitControls( camera, renderer.domElement );
	statusEl = document.getElementById( 'status' );

	// const url = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/stanford-bunny/bunny.glb';
	const url = '/FlightHelmet+clean.glb';

	// init ao texture
	aoTarget = new WebGLRenderTarget( TEXTURE_SIZE, TEXTURE_SIZE, {
		type: FloatType,
		colorSpace: NoColorSpace,
		generateMipmaps: true,
		format: RGBAFormat,
		minFilter: LinearMipmapLinearFilter,
		maxFilter: NearestFilter,
	} );
	aoTexture = aoTarget.texture;
	aoTexture.channel = TEXTURE_CHANNEL;

	// init ao generator
	aoGenerator = new AOThicknessMapGenerator( renderer );
	aoGenerator.samples = MAX_SAMPLES;
	aoGenerator.channel = TEXTURE_CHANNEL;
	aoGenerator.aoRadius = 2;
	aoGenerator.thicknessRadius = 0.5;

	// gltf material
	aoMaterial = new MeshPhysicalMaterial( {
		aoMap: aoTexture,
		thicknessMap: aoTexture,
		thickness: 1,
		attenuationColor: 0xfaeef2,
		attenuationDistance: 0.5,
	} );

	// quad for rendering texture result
	quad = new FullScreenQuad( new MeshBasicMaterial( { map: aoTexture } ) );

	const envPromise = new RGBELoader()
		.loadAsync( ENV_URL )
		.then( tex => {

			tex.mapping = EquirectangularReflectionMapping;
			background = tex;

		} );

	const geometriesToBake = [];

	io = new WebIO()
		.registerExtensions( ALL_EXTENSIONS )
		.registerDependencies( { 'meshopt.decoder': MeshoptDecoder } );

	const gltfPromise = io
		.read( url )
		.then( async _document => {

			sourceDocument = _document

			console.time( 'unwrap' );
			await _document.transform(
				unwrap( { watlas, groupBy: 'scene', texcoord: TEXTURE_CHANNEL } )
			);
			console.timeEnd( 'unwrap' );

			console.time( 'parse' );
			const documentView = new DocumentView( _document );
			const sceneDef = _document.getRoot().getDefaultScene();
			const content = documentView.view( sceneDef );
			console.timeEnd( 'parse' );

			const group = new Group();

			// scale the scene to a reasonable size
			const box = new Box3();
			box.setFromObject( content );

			const sphere = new Sphere();
			box.getBoundingSphere( sphere );

			content.scale.setScalar( 2.5 / sphere.radius );
			content.position.y = - 0.5 * ( box.max.y - box.min.y ) * 2.5 / sphere.radius;
			content.updateMatrixWorld();
			group.add( content );

			group.traverse( c => {

				if ( c.isMesh ) {

					geometriesToBake.push( c.geometry );

					c.material = aoMaterial;

				}

			} );

			scene.add( group );

		} );

	// wait for promises
	await Promise.all( [ gltfPromise, envPromise ] );

	document.getElementById( 'loading' ).remove();

	aoGenerator.startGeneration( geometriesToBake, aoTarget );

	onResize();
	window.addEventListener( 'resize', onResize );

	gui = new GUI();
	gui.add( params, 'transmission' );
	gui.add( params, 'displayMap' );
	gui.add( { download }, 'download' );

	stats = new Stats();
	document.body.appendChild( stats.domElement );

	animate();

}

function onResize() {

	const w = window.innerWidth;
	const h = window.innerHeight;

	renderer.setSize( w, h );
	renderer.setPixelRatio( window.devicePixelRatio );
	camera.aspect = w / h;
	camera.updateProjectionMatrix();

}

function animate() {

	stats.update();

	requestAnimationFrame( animate );

	if ( aoGenerator ) {

		if ( aoGenerator.generateSample() ) {

			totalSamples += aoGenerator.samplesPerUpdate;

		} else {

			aoGenerator = null;

		}

	}

	if ( params.transmission ) {

		aoMaterial.transmission = 1;
		aoMaterial.color.copy( aoMaterial.attenuationColor );
		aoMaterial.color.r *= 0.75;
		aoMaterial.color.g *= 0.5;
		aoMaterial.color.b *= 0.5;
		aoMaterial.roughness = 0.25;

		scene.background = background;

	} else {

		aoMaterial.transmission = 0;
		aoMaterial.color.set( 0xffffff );
		aoMaterial.roughness = 1;

		scene.background = null;

	}

	renderer.setRenderTarget( null );

	if ( params.displayMap ) {

		aoTexture.channel = 0;
		quad.render( renderer );

	} else {

		aoTexture.channel = TEXTURE_CHANNEL;
		renderer.render( scene, camera );

	}

	if ( aoGenerator ) {

		statusEl.innerText = `Samples: ${ totalSamples } of ${ MAX_SAMPLES }`;

	}

}

async function download() {

	const image = await renderTargetToBytes( aoTarget );
	const targetDocument = cloneDocument( sourceDocument );

	addAOThicknessTextureToDocument( targetDocument, image );

	const bytes = await io.writeBinary( targetDocument );
	const blob = new Blob( [ bytes ], { type: 'application/octet-stream' } );

	downloadBlob( blob, 'baked.glb' );

}

async function renderTargetToBytes( renderTarget ) {

	const texture = renderTarget.texture;
	const { width, height } = texture.image;

	const pixelsFloat = new Float32Array( width * height * 4 );
	const pixels = new Uint8Array( width * height * 4 );

	renderer.readRenderTargetPixels( renderTarget, 0, 0, width, height, pixelsFloat );

	for ( let i = 0; i < pixelsFloat.length; i ++ ) {

		pixels[ i ] = pixelsFloat[ i ] * 255;

	}

	const canvas = new OffscreenCanvas( width, height );
	const ctx = canvas.getContext( '2d' );

	if ( texture.flipY === true ) {

		ctx.translate( 0, height );
		ctx.scale( 1, - 1 );

	}

	const imageData = ctx.getImageData( 0, 0, width, height );

	for ( let i = 0; i < imageData.data.length; i += 4 ) {

		imageData.data[ i + 0 ] = pixels[ i + 0 ];
		imageData.data[ i + 1 ] = pixels[ i + 1 ];
		imageData.data[ i + 2 ] = pixels[ i + 2 ];
		imageData.data[ i + 3 ] = pixels[ i + 3 ];

	}

	ctx.putImageData( imageData, 0, 0 );

	const blob = await canvas.convertToBlob( { type: 'image/png' } );
	const buffer = await blob.arrayBuffer();
	return new Uint8Array( buffer );

}

function addAOThicknessTextureToDocument( document, image ) {

	const textureDef = document.createTexture( 'ao' )
		.setImage( image )
		.setMimeType( 'image/png' );

	const volumeExtension = document.createExtension( KHRMaterialsVolume );

	const volume = volumeExtension.createVolume()
		.setThicknessTexture( textureDef )
		.setThicknessFactor( 1.0 );

	volume.getThicknessTextureInfo()
		.setTexCoord( TEXTURE_CHANNEL );

	// If document has no materials, create one and assign to all primitives.
	if ( document.getRoot().listMaterials().length === 0 ) {

		const materialDef = document.createMaterial()
			.setOcclusionTexture( textureDef )
			.setOcclusionStrength( 1.0 )
			.setExtension( 'KHR_materials_volume', volume );

		materialDef.getOcclusionTextureInfo()
			.setTexCoord( TEXTURE_CHANNEL );

		for ( const mesh of document.getRoot().listMeshes() ) {

			for ( const prim of mesh.listPrimitives() ) {

				prim.setMaterial( materialDef );

			}

		}

		return;

	}

	// Update existing materials.

	for ( const materialDef of document.getRoot().listMaterials() ) {

		materialDef
			.setOcclusionTexture( textureDef )
			.setOcclusionStrength( 1.0 );

		materialDef.getOcclusionTextureInfo()
			.setTexCoord( TEXTURE_CHANNEL );

		if ( materialDef.getExtension( 'KHR_materials_volume' ) ) {

			materialDef.getExtension( 'KHR_materials_volume' )
				.setThicknessTexture( textureDef )
				.setThicknessFactor( 1.0 );

			materialDef.getExtension( 'KHR_materials_volume' )
				.getThicknessTextureInfo()
				.setTexCoord( TEXTURE_CHANNEL );

		} else {

			materialDef.setExtension( 'KHR_materials_volume', volume );

		}

	}

}

let _anchorEl

function downloadBlob( blob, filename ) {

	if ( ! _anchorEl ) {

		_anchorEl = document.createElement( 'a' );
		_anchorEl.style.display = 'none';
		document.body.appendChild( _anchorEl );

	}

	_anchorEl.href = URL.createObjectURL( blob );
	_anchorEl.download = filename;
	_anchorEl.click();

	URL.revokeObjectURL( _anchorEl.href );

}
