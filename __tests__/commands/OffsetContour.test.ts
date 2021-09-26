import * as THREE from "three";
import { CenterCircleFactory } from "../../src/commands/circle/CircleFactory";
import OffsetContourFactory, { OffsetCurveFactory, OffsetFaceFactory } from "../../src/commands/curve/OffsetContourFactory";
import CylinderFactory from "../../src/commands/cylinder/CylinderFactory";
import { EditorSignals } from '../../src/editor/EditorSignals';
import { GeometryDatabase } from '../../src/editor/GeometryDatabase';
import MaterialDatabase from '../../src/editor/MaterialDatabase';
import * as visual from '../../src/editor/VisualModel';
import { FakeMaterials } from "../../__mocks__/FakeMaterials";
import '../matchers';

let db: GeometryDatabase;
let materials: Required<MaterialDatabase>;
let signals: EditorSignals;

beforeEach(() => {
    materials = new FakeMaterials();
    signals = new EditorSignals();
    db = new GeometryDatabase(materials, signals);
})

describe(OffsetFaceFactory, () => {
    let offsetContour: OffsetFaceFactory;

    beforeEach(() => {
        offsetContour = new OffsetFaceFactory(db, materials, signals);
    });

    describe('faces', () => {
        let cylinder: visual.Solid;

        beforeEach(async () => {
            const makeCylinder = new CylinderFactory(db, materials, signals);
            makeCylinder.base = new THREE.Vector3();
            makeCylinder.radius = new THREE.Vector3(1, 0, 0);
            makeCylinder.height = new THREE.Vector3(0, 0, 10);
            cylinder = await makeCylinder.commit() as visual.Solid;
        })

        test('it works', async () => {
            offsetContour.face = cylinder.faces.get(1);
            offsetContour.distance = 0.1;
            const curve = await offsetContour.commit() as visual.SpaceInstance<visual.Curve3D>;
            const bbox = new THREE.Box3().setFromObject(curve);
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            expect(center).toApproximatelyEqual(new THREE.Vector3());
            expect(bbox.min).toApproximatelyEqual(new THREE.Vector3(-1.1, -1.1, 0));
            expect(bbox.max).toApproximatelyEqual(new THREE.Vector3(1.1, 1.1, 0));
        });
    });
});

describe(OffsetCurveFactory, () => {
    let offsetCurve: OffsetCurveFactory;

    beforeEach(() => {
        offsetCurve = new OffsetCurveFactory(db, materials, signals);
    });

    describe('planar curves', () => {
        let circle: visual.SpaceInstance<visual.Curve3D>;

        beforeEach(async () => {
            const makeCircle = new CenterCircleFactory(db, materials, signals);
            makeCircle.center = new THREE.Vector3();
            makeCircle.radius = 1;
            circle = await makeCircle.commit() as visual.SpaceInstance<visual.Curve3D>;
        })

        test('it works', async () => {
            offsetCurve.curve = circle;
            offsetCurve.distance = 0.1;
            const curve = await offsetCurve.commit() as visual.SpaceInstance<visual.Curve3D>;
            const bbox = new THREE.Box3().setFromObject(curve);
            const center = new THREE.Vector3();
            bbox.getCenter(center);
            expect(center).toApproximatelyEqual(new THREE.Vector3());
            expect(bbox.min).toApproximatelyEqual(new THREE.Vector3(-0.9, -0.9, 0));
            expect(bbox.max).toApproximatelyEqual(new THREE.Vector3(0.9, 0.9, 0));
        });
    });
});
