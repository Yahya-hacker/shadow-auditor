declare module 'yoga-layout-prebuilt' {
  interface YogaNode {
    calculateLayout(width: number, height: number, direction: number): void;
    free(): void;
    freeRecursive(): void;
    getComputedLayout(): { height: number; left: number; top: number; width: number };
    insertChild(child: YogaNode, index: number): void;
    setFlex(flex: number): void;
    setFlexDirection(direction: number): void;
    setHeight(height: number): void;
    setWidth(width: number): void;
  }

  const Yoga: {
    DIRECTION_LTR: number;
    FLEX_DIRECTION_COLUMN: number;
    Node: {
      create(): YogaNode;
    };
  };

  export = Yoga;
}
