import c3d from '../../../build/Release/c3d.node';
import { Polyline2ContourFactory } from '../../commands/modify_contour/ContourFilletFactory';
import { curve3d2curve2d, isSamePlacement, normalizePlacement } from '../../util/Conversion';
import { Curve2dId, CurveInfo, Joint, PointOnCurve, Transaction, Trim } from './ContourManager';
import { EditorSignals } from '../EditorSignals';
import { DatabaseLike } from '../GeometryDatabase';
import { CurveMemento, MementoOriginator } from '../History';
import MaterialDatabase from '../MaterialDatabase';
import * as visual from "../VisualModel";

export class PlanarCurveDatabase implements MementoOriginator<CurveMemento> {
    private readonly curve2info = new Map<c3d.SimpleName, CurveInfo>();
    private readonly id2planarCurve = new Map<c3d.SimpleName, c3d.Curve>();
    private readonly placements = new Set<c3d.Placement3D>();
    private counter = 0;

    constructor(
        private readonly db: DatabaseLike,
        private readonly materials: MaterialDatabase,
        private readonly signals: EditorSignals
    ) {
        const origin = new c3d.CartPoint3D(0, 0, 0);
        const X = new c3d.Vector3D(1, 0, 0);
        const Y = new c3d.Vector3D(0, 1, 0);
        const Z = new c3d.Vector3D(0, 0, 1);
        this.placements.add(new c3d.Placement3D(origin, Z, X, false));
    }

    /**
     * Summary of algorithm: to add a new curve, first find its intersections with all other curves.
     * Now, suppose there's one intersection along the parameter of the curve at i. This intersection
     * cuts the curve in two. Thus we trim curve from [0,i], and [i,1], assuming 0 and 1 are tmin and
     * tmax. Then we process the next curve (the one we intersected with earlier), since it also has
     * been cut in two.
     *
     * There are a lot of edge cases, e.g., circular (closed) curves, curves whose endpoints intersect the
     * startpoints of the next curve (a "joint"), etc. etc.
     */
    async add(newCurve: visual.SpaceInstance<visual.Curve3D>): Promise<void> {
        const { curve2info, db, id2planarCurve } = this;

        const inst = db.lookup(newCurve);
        const item = inst.GetSpaceItem()!;
        let curve3d = item.Cast<c3d.Curve3D>(item.IsA());

        // If the curve is a Polyline, convert to Contour
        if (curve3d.IsA() === c3d.SpaceType.Polyline3D) {
            const factory = new Polyline2ContourFactory(db, this.materials, this.signals);
            factory.polyline = newCurve;
            const inst = await factory.calculate();
            const item = inst.GetSpaceItem()!;
            curve3d = item.Cast<c3d.Curve3D>(item.IsA());
        }

        // Planarize the new curve
        const planarInfo = this.planarizeAndNormalize(curve3d);
        if (planarInfo === undefined) return;
        const { curve: newPlanarCurve, placement } = planarInfo;

        // Collect all existing planar curves on same placement
        const planar2instance = new Map<Curve2dId, c3d.SimpleName>();
        const allPlanarCurves = [];
        for (const [simpleName, { planarCurve, placement: existingPlacement }] of curve2info.entries()) {
            const curve = id2planarCurve.get(planarCurve)!;
            if (isSamePlacement(placement, existingPlacement))
                allPlanarCurves.push(curve);
            planar2instance.set(curve.Id(), simpleName);
        }

        // Store the planarized curve for future use
        const counter = this.counter++;
        id2planarCurve.set(counter, newPlanarCurve);
        const info = new CurveInfo(counter, placement);
        curve2info.set(newCurve.simpleName, info);
        planar2instance.set(newPlanarCurve.Id(), newCurve.simpleName);
        allPlanarCurves.push(newPlanarCurve);

        // Process all curves that intersect the new curve (and their intersections), starting with the new curve itself
        const curvesToProcess = new Map<Curve2dId, c3d.Curve>();
        curvesToProcess.set(newPlanarCurve.Id(), newPlanarCurve);
        const visited = new Set<Curve2dId>();

        const promises = [];
        while (curvesToProcess.size > 0) {
            const [id, current] = curvesToProcess.entries().next().value as [bigint, c3d.Curve];
            const name = planar2instance.get(id)!;
            const { view } = db.lookupItemById(name);
            visited.add(id);
            curvesToProcess.delete(id);

            const crosses = c3d.CurveEnvelope.IntersectWithAll(current, allPlanarCurves, true);

            // If the curve is a contour, break it into segments and fake those as cross points
            if (current.IsA() === c3d.PlaneType.Contour) {
                const contour = current.Cast<c3d.Contour>(c3d.PlaneType.Contour);
                const params = contour.GetCornerParams();
                for (const param of params) {
                    const pointOnCurve1 = new c3d.PointOnCurve(param, current);
                    const cross = new c3d.CrossPoint(new c3d.CartPoint(0, 0), pointOnCurve1, pointOnCurve1);
                    crosses.push(cross);
                }
                // If it's closed, add the beginning point
                if (contour.IsClosed()) {
                    const pointOnCurve1 = new c3d.PointOnCurve(0, current);
                    const cross = new c3d.CrossPoint(new c3d.CartPoint(0, 0), pointOnCurve1, pointOnCurve1);
                    crosses.push(cross);
                }
            }

            if (crosses.length === 0) {
                promises.push(this.updateCurve(view as visual.SpaceInstance<visual.Curve3D>, [{ trimmed: current, start: -1, stop: -1 }], placement));
                continue;
            }

            crosses.sort((a, b) => a.on1.t - b.on1.t);

            const { on1: { curve: curve1 } } = crosses[0];
            const view1simplename = planar2instance.get(curve1.Id())!;
            const info = curve2info.get(view1simplename)!;

            // For bounded (finite) open curves (like line segments), we need to add in the beginning and end points
            if (current.IsBounded() && !current.IsClosed()) {
                this.addJoint(crosses[0], planar2instance);
                this.addJoint(crosses[crosses.length - 1], planar2instance);

                const begPointOn = new c3d.PointOnCurve(current.GetTMin(), current);
                const begCrossPoint = new c3d.CrossPoint(current.GetLimitPoint(1), begPointOn, begPointOn);
                crosses.unshift(begCrossPoint);

                const endPointOn = new c3d.PointOnCurve(current.GetTMax(), current);
                const endCrossPoint = new c3d.CrossPoint(current.GetLimitPoint(2), endPointOn, endPointOn);
                crosses.push(endCrossPoint);
            } else if (current.IsClosed()) { // And for closed/looping curves we need to add a point
                crosses.push(crosses[0]);
            }

            // The crosses (intersections) are sorted, so each t[i] (start) to t[i+1] (stop) section of the curve is a cuttable.
            let start = crosses[0].on1.t;
            const trims: Trim[] = [];
            for (const cross of crosses) {
                const { on1: { t }, on2: { curve: other } } = cross;
                const otherId = other.Id();

                const id = planar2instance.get(otherId)!;
                const touched = db.lookupItemById(id).view as visual.SpaceInstance<visual.Curve3D>;
                info.touched.add(touched.simpleName);

                const stop = t;
                if (Math.abs(start - stop) > 10e-6) {
                    const trimmed = curve1.Trimmed(start, stop, 1)!;
                    trims.push({ trimmed, start, stop });
                }
                start = stop;

                if (!visited.has(otherId)) {
                    curvesToProcess.set(otherId, other);
                }
            }

            promises.push(this.updateCurve(view as visual.SpaceInstance<visual.Curve3D>, trims, placement));
        }
        await Promise.all(promises);
    }

    private removeInfo(curve: c3d.SimpleName): CurveInfo | undefined {
        const { curve2info, db } = this;

        const info = curve2info.get(curve);
        if (info === undefined) return;
        curve2info.delete(curve);

        const { fragments } = info;

        for (const fragment of fragments) {
            fragment.then(fragment => {
                const item = db.lookupItemById(fragment).view;
                db.removeItem(item, 'automatic');
            });
        }
        return info;
    }

    cascade(curve: visual.SpaceInstance<visual.Curve3D>, transaction: Transaction = { dirty: new Set(), deleted: new Set(), added: new Set() }) {
        const { dirty, deleted: deleted, added } = transaction;

        deleted.add(curve.simpleName);

        const { curve2info } = this;

        const info = curve2info.get(curve.simpleName);
        if (info === undefined)
            return transaction;
        const { touched } = info;

        const visited = dirty;
        let walk = [...touched];
        while (walk.length > 0) {
            const touchee = walk.pop()!;
            if (visited.has(touchee)) continue;

            visited.add(touchee);
            walk = walk.concat([...curve2info.get(touchee)!.touched]);
        }

        return transaction;
    }

    async commit(data: Transaction): Promise<void> {
        const promises = [];
        for (const touchee of data.dirty) {
            this.removeInfo(touchee);
        }
        for (const touchee of data.deleted) {
            if (data.dirty.has(touchee)) continue;

            this.removeInfo(touchee);
        }
        for (const touchee of data.dirty) {
            if (data.deleted.has(touchee)) continue;

            const inst = this.db.lookupItemById(touchee).view as visual.SpaceInstance<visual.Curve3D>;
            promises.push(this.add(inst));
        }
        for (const touchee of data.added) {
            if (data.deleted.has(touchee)) continue;
            if (data.dirty.has(touchee)) continue;

            const inst = this.db.lookupItemById(touchee).view as visual.SpaceInstance<visual.Curve3D>;
            promises.push(this.add(inst));
        }

        await Promise.all(promises);
        return;
    }

    async remove(curve: visual.SpaceInstance<visual.Curve3D>): Promise<void> {
        const data = this.cascade(curve);
        await this.commit(data);
    }

    private async updateCurve(instance: visual.SpaceInstance<visual.Curve3D>, result: Trim[], placement: c3d.Placement3D): Promise<void> {
        const { curve2info, db } = this;
        const info = curve2info.get(instance.simpleName)!;
        for (const invalid of info.fragments) {
            invalid.then(invalid => {
                const item = db.lookupItemById(invalid).view;
                db.removeItem(item, 'automatic')
            });
        }
        const views: Promise<c3d.SimpleName>[] = [];
        for (const { trimmed, start, stop } of result) {
            const inst = new c3d.SpaceInstance(new c3d.PlaneCurve(placement, trimmed, true));
            const p = db.addItem(inst, 'automatic').then(item => {
                for (const curve of item.levels)
                    curve.befragment(start, stop, instance);
                return item.simpleName;
            });
            views.push(p);
        }
        info.fragments = views;
        await Promise.all(views);
    }

    private planarizeAndNormalize(curve3d: c3d.Curve3D): { curve: c3d.Curve; placement: c3d.Placement3D; } | undefined {
        const hint = new c3d.Placement3D();
        const planar = curve3d2curve2d(curve3d, hint);
        if (planar === undefined) return;

        const { curve, placement } = planar;
        const bestExistingPlacement = normalizePlacement(curve, placement, this.placements);
        return { curve, placement: bestExistingPlacement };
    }

    lookup(instance: visual.SpaceInstance<visual.Curve3D> | c3d.SimpleName): Readonly<CurveInfo> {
        const simpleName = instance instanceof visual.SpaceInstance ? instance.simpleName : instance;
        return this.curve2info.get(simpleName)!;
    }

    findWithSamePlacement(placement: c3d.Placement3D): c3d.Curve[] {
        const candidates = this.curve2info.values();
        const coplanarCurves = [];
        for (const candidate of candidates) {
            if (isSamePlacement(placement, candidate.placement)) {
                coplanarCurves.push(this.id2planarCurve.get(candidate.planarCurve)!);
            }
        }
        return coplanarCurves;
    }

    private addJoint(cross: c3d.CrossPoint, planar2instance: Map<Curve2dId, c3d.SimpleName>) {
        const { on1: { curve: curve1, t: t1 }, on2: { curve: curve2, t: t2 } } = cross;
        const view1simpleName = planar2instance.get(curve1.Id())!;
        const view2simpleName = planar2instance.get(curve2.Id())!;
        const info1 = this.curve2info.get(view1simpleName)!;
        const info2 = this.curve2info.get(view2simpleName)!;

        const t1min = curve1.GetTMin();
        const t1max = curve1.GetTMax();
        const t2min = curve2.GetTMin();
        const t2max = curve2.GetTMax();

        if (t1 !== t1min && t1 !== t1max) return;

        const on1 = new PointOnCurve(view1simpleName, t1, t1min, t1max);
        const on2 = new PointOnCurve(view2simpleName, t2, t2min, t2max);

        if (t1 === curve1.GetTMin())
            info1.joints.start = new Joint(on1, on2);
        else
            info1.joints.stop = new Joint(on1, on2);

        if (t2 === curve2.GetTMin())
            info2.joints.start = new Joint(on2, on1);
        else if (t2 === curve2.GetTMax())
            info2.joints.stop = new Joint(on2, on1);
    }

    saveToMemento(): CurveMemento {
        return new CurveMemento(
            new Map(this.curve2info),
            new Map(this.id2planarCurve),
            new Set(this.placements));
    }

    restoreFromMemento(m: CurveMemento) {
        (this.curve2info as PlanarCurveDatabase['curve2info']) = m.curve2info;
        (this.id2planarCurve as PlanarCurveDatabase['id2planarCurve']) = m.id2planarCurve;
        (this.placements as PlanarCurveDatabase['placements']) = m.placements;
    }

    serialize(): Promise<Buffer> {
        throw new Error('Method not implemented.');
    }

    deserialize(data: Buffer): Promise<void> {
        throw new Error('Method not implemented.');
    }

    validate() {
    }

    debug() {

    }
}

