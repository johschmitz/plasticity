import * as THREE from "three";
import c3d from '../../../build/Release/c3d.node';
import * as visual from '../../editor/VisualModel';
import { inst2curve, point2point, vec2vec } from '../../util/Conversion';
import { NoOpError, ValidationError } from '../GeometryFactory';
import { ContourFactory } from "./ContourFilletFactory";

export interface SegmentAngle {
    origin: THREE.Vector3;
    normal: THREE.Vector3;
}

export interface ModifyContourParams {
    distance: number;
    segment: number;
    segmentAngles: SegmentAngle[];
}

export class ModifyContourFactory extends ContourFactory implements ModifyContourParams {
    private _contour!: c3d.Contour3D;
    get contour(): c3d.Contour3D { return this._contour }
    set contour(inst: c3d.Contour3D | c3d.SpaceInstance | visual.SpaceInstance<visual.Curve3D>) {
        if (inst instanceof c3d.SpaceInstance) {
            const curve = inst2curve(inst);
            if (!(curve instanceof c3d.Contour3D)) throw new ValidationError("Contour expected");
            this._contour = curve;
        } else if (inst instanceof visual.SpaceInstance) {
            this.contour = this.db.lookup(inst);
            return;
        } else this._contour = inst;

        let fillNumber = this.contour.GetSegmentsCount();
    }

    distance = 0;
    segment!: number;

    async calculate() {
        const { contour, segment: index, distance } = this;

        if (distance === 0) throw new NoOpError();

        const segments = contour.GetSegments();

        let active = segments[index];
        let before = segments[(index - 1 + segments.length) % segments.length];
        let after = segments[(index + 1) % segments.length];

        before = before.Cast<c3d.Curve3D>(before.IsA());
        after = after.Cast<c3d.Curve3D>(after.IsA());
        active = active.Cast<c3d.Curve3D>(active.IsA());

        let before_tmax = before.GetTMax();
        let before_tmin = before.GetTMin();
        let after_tmin = after.GetTMin();
        let after_tmax = after.GetTMax();

        let before_tangent_begin = vec2vec(before.Tangent(before_tmin), 1);
        let before_tangent_end = vec2vec(before.Tangent(before_tmax), 1);
        let after_tangent_begin = vec2vec(after.Tangent(after_tmin), 1).multiplyScalar(-1);
        let after_tangent_end = vec2vec(after.Tangent(after_tmax), 1).multiplyScalar(-1);

        const active_tangent_begin = vec2vec(active.Tangent(active.GetTMin()), 1);
        const active_tangent_end = vec2vec(active.Tangent(active.GetTMax()), 1);

        let before_pmax = point2point(before.GetLimitPoint(2));
        let after_pmin = point2point(after.GetLimitPoint(1));
        let radiusBefore = 0;
        let radiusAfter = 0;

        if (before instanceof c3d.Arc3D) {
            radiusBefore = before.GetRadius();

            const before_before = segments[(index - 2 + segments.length) % segments.length];

            const before_before_tmin = before_before.GetTMin();
            const before_before_tmax = before_before.GetTMax();
            const before_before_tangent_begin = vec2vec(before_before.Tangent(before_before_tmin), 1);
            const before_before_tangent_end = vec2vec(before_before.Tangent(before_before_tmax), 1);
            const smooth1 = Math.abs(1 - before_before_tangent_begin.dot(before_tangent_begin)) < 10e-5;
            const smooth2 = Math.abs(1 - before_tangent_end.dot(active_tangent_begin)) < 10e-5;
            if (smooth1 && smooth2) {
                before = before_before;
                before_tmin = before_before_tmin;
                const before_before_pmax = before.GetLimitPoint(2);
                const before_before_ext_p = point2point(before_before_pmax).add(before_before_tangent_end);
                const active_pmin = before_pmax;
                const active_ext_p = active_pmin.clone().add(active_tangent_begin);
                const before_before_line = new c3d.Line3D(before_before_pmax, point2point(before_before_ext_p));
                const active_line = new c3d.Line3D(point2point(active_pmin), point2point(active_ext_p));
                const { result1, count } = c3d.ActionPoint.CurveCurveIntersection3D(before_before_line, active_line, 10e-6);
                if (count < 1) throw new Error("Invalid precondition");

                const p = before_before_line._PointOn(result1[0]);
                before_pmax = point2point(p);
                const { t } = before.NearPointProjection(p, true);
                before_tmax = t;

                before_tangent_begin = before_before_tangent_begin;
                before_tangent_end = before_before_tangent_end;
            }
        }

        if (after instanceof c3d.Arc3D) {
            radiusAfter = after.GetRadius();

            const after_after = segments[(index + 2) % segments.length];

            const after_after_tmin = after_after.GetTMin();
            const after_after_tmax = after_after.GetTMax();
            const after_after_tangent_begin = vec2vec(after_after.Tangent(after_after_tmin), 1).multiplyScalar(-1);
            const after_after_tangent_end = vec2vec(after_after.Tangent(after_after_tmax), 1).multiplyScalar(-1);
            const smooth1 = Math.abs(1 - Math.abs(after_after_tangent_begin.dot(after_tangent_end))) < 10e-5;
            const smooth2 = Math.abs(1 - Math.abs(after_tangent_begin.dot(active_tangent_end))) < 10e-5;
            if (smooth1 && smooth2) {
                after = after_after;
                after_tmax = after_after_tmax;
                const after_after_pmin = after.GetLimitPoint(1);
                const after_after_ext_p = point2point(after_after_pmin).add(after_after_tangent_begin);
                const active_pmax = after_pmin;
                const active_ext_p = active_pmax.clone().add(active_tangent_end);
                const after_after_line = new c3d.Line3D(after_after_pmin, point2point(after_after_ext_p));
                const active_line = new c3d.Line3D(point2point(active_pmax), point2point(active_ext_p));
                const { result1, count } = c3d.ActionPoint.CurveCurveIntersection3D(after_after_line, active_line, 10e-6);
                if (count < 1) throw new Error("Invalid precondition");

                const p = after_after_line._PointOn(result1[0]);
                after_pmin = point2point(p);
                const { t } = after.NearPointProjection(p, true);
                after_tmin = t;

                after_tangent_begin = after_after_tangent_begin;
                after_tangent_end = after_after_tangent_end;
            }
        }

        const alpha = before_tangent_end.angleTo(after_tangent_begin);
        const beta = active_tangent_end.angleTo(after_tangent_begin);
        const gamma = active_tangent_begin.angleTo(before_tangent_end.multiplyScalar(-1));

        const x = alpha + gamma - Math.PI / 2;
        const y = alpha + beta - Math.PI / 2;

        const before_distance = distance / Math.cos(y);
        const after_distance = distance / Math.cos(x);

        const before_ext_p = point2point(before_pmax.add(before_tangent_end.multiplyScalar(-before_distance)));
        const after_ext_p = point2point(after_pmin.add(after_tangent_begin.multiplyScalar(after_distance)));

        const { t: before_ext_t } = before.NearPointProjection(before_ext_p, true);
        const { t: after_ext_t } = after.NearPointProjection(after_ext_p, true);
        const before_extended = before.Trimmed(before_tmin, before_ext_t, 1)!;
        const after_extended = after.Trimmed(after_ext_t, after_tmax, 1)!;

        const active_new = new c3d.Polyline3D([before_ext_p, after_ext_p], false);

        const outContour = new c3d.Contour3D();
        for (let i = 0; i < index - 1 - (radiusBefore > 0 ? 1 : 0); i++) {
            outContour.AddCurveWithRuledCheck(segments[i], 1e-6, true);
        }

        outContour.AddCurveWithRuledCheck(before_extended, 1e-6, true);
        outContour.AddCurveWithRuledCheck(active_new, 1e-6, true);
        outContour.AddCurveWithRuledCheck(after_extended, 1e-6, true);

        for (let i = index + 2 + (radiusBefore > 0 ? 1 : 0); i < segments.length - (index === 0 ? 1 : 0); i++) {
            outContour.AddCurveWithRuledCheck(segments[i], 1e-6, true);
        }

        if (radiusBefore === 0 && radiusAfter === 0) return new c3d.SpaceInstance(outContour);
        else {
            const numFillets = radiusBefore > 0 ? radiusAfter > 0 ? 2 : 1 : 0;
            let fillNumber = segments.length - numFillets;
            fillNumber -= this.contour.IsClosed() ? 0 : 1;
            const radiuses = new Array<number>(fillNumber);
            radiuses.fill(0);
            if (numFillets < 2) {
                if (radiusBefore > 0) radiuses[index] = radiusBefore;
                if (radiusAfter > 0) radiuses[index] = radiusAfter;
            } else {
                radiuses[index - 2] = radiusBefore;
                radiuses[index - 1] = radiusAfter;
            }
            const result = c3d.ActionSurfaceCurve.CreateContourFillets(outContour, radiuses, c3d.ConnectingType.Fillet);
            return new c3d.SpaceInstance(result);
        }

    }

    get segmentAngles(): SegmentAngle[] {
        const result: SegmentAngle[] = [];
        const contour = this._contour;
        const segments = contour.GetSegments();
        for (const [i, segment] of segments.entries()) {
            const center = segment.GetCentre();
            const active_tangent_end = vec2vec(segment.Tangent(segment.GetTMax()), 1);
            const after = segments[(i + 1) % segments.length];
            const after_tmin = after.GetTMin();
            const after_tangent = vec2vec(after.Tangent(after_tmin), 1).multiplyScalar(-1);
            const normal = new THREE.Vector3();
            normal.crossVectors(active_tangent_end, after_tangent).cross(active_tangent_end).normalize();

            const { t } = segment.NearPointProjection(center, false);
            result.push({
                origin: point2point(center),
                normal,
            });
        }
        return result;
    }
}