import * as cmd from "../../command/Command";
import { MaterialDialog } from "./MaterialDialog";
import * as THREE from "three";
import { GeometryFactory } from "../../command/GeometryFactory";
import { defaultPhysicalMaterial } from "../../visual_model/RenderedSceneBuilder";

export interface MaterialParams {
    color: THREE.Color;
    metalness: number;
    roughness: number;
    ior: number;
    clearcoat: number;
    clearcoatRoughness: number;
    sheen: number;
    sheenRoughness: number;
    sheenColor: THREE.Color;
    specularIntensity: number;
    specularColor: THREE.Color;
    transmission: number;
    thickness: number;
}

export class SetMaterialCommand extends cmd.CommandLike {
    async execute(): Promise<void> {
        const { editor: { db, scene, selection: { selected }, materials, signals } } = this;
        const node = selected.solids.first ?? selected.groups.first;
        let material = scene.getMaterial(node) as THREE.MeshPhysicalMaterial;
        if (material === undefined) {
            material = defaultPhysicalMaterial.clone();
            const id = materials.add("New material", material);
            scene.setMaterial(node, id);
        }

        const dialog = new MaterialDialog(material, signals);
        dialog.execute(() => {
            signals.factoryUpdated.dispatch();
        }).resource(this).then(() => this.finish(), () => this.cancel());

        await this.finished;

    }
}