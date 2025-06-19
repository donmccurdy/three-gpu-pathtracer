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
	NoColorSpace
} from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { AOThicknessMapGenerator } from '../src/utils/AOThicknessMapGenerator.js';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { unwrap } from '@gltf-transform/functions';
import { DocumentView } from '@gltf-transform/view';
import * as watlas from 'watlas';

const ENV_URL = 'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aristea_wreck_puresky_2k.hdr';

let renderer, camera, scene, stats;
let statusEl, totalSamples = 0;
let aoGenerator, aoTarget, aoTexture, gui, aoMaterial;
let background;
let quad;
let io, gltfDocument;

const params = {
	transmission: false,
	displayMap: false,
};

const AO_THICKNESS_TEXTURE_SIZE = 1024;
const MAX_SAMPLES = 1000;

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
	aoTarget = new WebGLRenderTarget( AO_THICKNESS_TEXTURE_SIZE, AO_THICKNESS_TEXTURE_SIZE, {
		type: FloatType,
		colorSpace: NoColorSpace,
		generateMipmaps: true,
		format: RGBAFormat,
	} );
	aoTexture = aoTarget.texture;
	aoTexture.channel = 2;

	// init ao generator
	aoGenerator = new AOThicknessMapGenerator( renderer );
	aoGenerator.samples = MAX_SAMPLES;
	aoGenerator.channel = 2;
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
	quad = new FullScreenQuad( new MeshBasicMaterial( {
		map: aoTexture,
	} ) );

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

			gltfDocument = _document

			console.time( 'unwrap' );
			await _document.transform(
				unwrap( { watlas, texcoord: 2, groupBy: 'scene' } )
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
	gui.add( { onExport }, 'onExport' );

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

		aoTexture.channel = 2;
		renderer.render( scene, camera );

	}

	if ( aoGenerator ) {

		statusEl.innerText = `Samples: ${ totalSamples } of ${ MAX_SAMPLES }`;

	}

}

async function onExport() {

	console.log( aoTexture );

	const { width, height } = aoTexture.image;

	const aoPixelsFloat = new Float32Array( width * height * 4 );
	const aoPixelsByte = new Uint32Array( width * height * 4 );

	renderer.readRenderTargetPixels( aoTarget, 0, 0, width, height, aoPixelsFloat );

	for ( let i = 0; i < aoPixelsFloat.length; i ++ ) {

		aoPixelsByte[ i ] = aoPixelsFloat[ i ] * 255;

	}

	console.log( { aoPixelsByte } );

	const canvas = new OffscreenCanvas( width, height );

	const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

	if ( aoTexture.flipY === true ) {

		ctx.translate( 0, canvas.height );
		ctx.scale( 1, - 1 );

	}

	const imageData = ctx.getImageData( 0, 0, canvas.width, canvas.height );

	for ( let i = 0; i < imageData.data.length; i += 4 ) {

		imageData.data[ i + 0 ] = aoPixelsByte[ i + 0 ];
		imageData.data[ i + 1 ] = aoPixelsByte[ i + 1 ];
		imageData.data[ i + 2 ] = aoPixelsByte[ i + 2 ];
		imageData.data[ i + 3 ] = aoPixelsByte[ i + 3 ];

	}

	ctx.putImageData( imageData, 0, 0 );

	const imageBlob = await canvas.convertToBlob( { type: 'image/png' } );
	const imageBuffer = await imageBlob.arrayBuffer();

	const aoTextureDef = gltfDocument.createTexture( 'ao' )
		.setImage( new Uint8Array( imageBuffer ) )
		.setMimeType( 'image/png' );

	if ( gltfDocument.getRoot().listMaterials().length === 0 ) {

		const materialDef = gltfDocument.createMaterial()
			.setOcclusionTexture( aoTextureDef )
			.setOcclusionStrength( 1.0 );

		materialDef.getOcclusionTextureInfo()
			.setTexCoord( 2 );

		for ( const mesh of gltfDocument.getRoot().listMeshes() ) {

			for ( const prim of mesh.listPrimitives() ) {

				prim.setMaterial( materialDef );

			}

		}

	} else {

		for ( const materialDef of gltfDocument.getRoot().listMaterials() ) {

			materialDef
				.setOcclusionTexture( aoTextureDef )
				.setOcclusionStrength( 1.0 );

			materialDef.getOcclusionTextureInfo()
				.setTexCoord( 2 );

		}

	}

	const outputBytes = await io.writeBinary( gltfDocument );
	const outputBlob = new Blob( [ outputBytes ], { type: 'application/octet-stream' } );

	save( outputBlob, 'baked.glb' );

	console.log( 'glb', outputBytes );

}


const link = document.createElement( 'a' );
link.style.display = 'none';
document.body.appendChild( link ); // Firefox workaround, see #6594

function save( blob, filename ) {

	link.href = URL.createObjectURL( blob );
	link.download = filename;
	link.click();

	URL.revokeObjectURL( link.href );

}
