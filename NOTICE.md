# Source provenance

The initial editor document behavior is extracted and adapted from [lanej/studio at 710f6e03d1a177efb2640782e03ee063ef68afea](https://github.com/lanej/studio/tree/710f6e03d1a177efb2640782e03ee063ef68afea), including its Neovim document client and native acceptance scenarios. Studio retains planning schemas, SQLite state, workflow authority, conversation integration and Zellij launching. This repository owns the independent interfaces, local transport, generic document synchronization and Neovim runtime.

Generated TypeScript bindings come from the checked-in Protobuf service and pinned Buf/Protobuf-ES tools. Their generated headers and the Protovalidate descriptor dependency retain upstream notices. External runtime libraries remain declared package dependencies; their licenses are supplied with those packages.
