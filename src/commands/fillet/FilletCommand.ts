import * as THREE from "three";
import { Mode } from "../../command/AbstractGizmo";
import Command from "../../command/Command";
import { PointPicker } from "../../command/PointPicker";
import * as visual from "../../visual_model/VisualModel";
import { FilletDialog } from "./FilletDialog";
import FilletFactory, { MaxFilletFactory, MultiFilletFactory } from './FilletFactory';
import { FilletSolidGizmo } from './FilletGizmo';
import { ChamferAndFilletKeyboardGizmo } from "./FilletKeyboardGizmo";

export class FilletSolidCommand extends Command {
    point?: THREE.Vector3;

    async execute(): Promise<void> {
        const edges = [...this.editor.selection.selected.edges];
        const edge = edges[edges.length - 1];
        // const item = edge.parentItem as visual.Solid;

        const fillet = new MultiFilletFactory(this.editor.db, this.editor.materials, this.editor.signals).resource(this);
        // fillet.solid = item;
        fillet.edges = edges;
        // fillet.start();

        const gizmo = new FilletSolidGizmo(fillet, this.editor, this.point);
        gizmo.showEdges();

        const keyboard = new ChamferAndFilletKeyboardGizmo(this.editor);
        const dialog = new FilletDialog(fillet, this.editor.signals);

        dialog.execute(async (params) => {
            gizmo.toggle(fillet.mode);
            keyboard.toggle(fillet.mode);
            gizmo.render(params.distance1);
            await fillet.update();
        }).resource(this).then(() => this.finish(), () => this.cancel());

        const variable = new PointPicker(this.editor);
        const restriction = variable.restrictToEdges(edges);
        variable.raycasterParams.Line2.threshold = 300;
        variable.raycasterParams.Points.threshold = 50;
        keyboard.execute(async (s) => {
            switch (s) {
                case 'add':
                    const { point } = await variable.execute().resource(this);
                    const { model, view } = restriction.match;
                    const t = restriction.match.t(point);
                    const fn = fillet.functions.get(view.simpleName)!;
                    const added = gizmo.addVariable(point, model, t);
                    added.execute(async (delta) => {
                        fn.InsertValue(t, delta);
                        await fillet.update();
                    }, Mode.Persistent).resource(this);
                    break;
            }
        }).resource(this);

        gizmo.execute(async (params) => {
            keyboard.toggle(fillet.mode);
            gizmo.toggle(fillet.mode);
            dialog.toggle(fillet.mode);
            dialog.render();
            await fillet.update();
        }).resource(this);

        await this.finished;

        const results = await fillet.commit() as visual.Solid[];
        this.editor.selection.selected.add(results);
    }
}
