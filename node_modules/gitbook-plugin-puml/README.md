# PlantUML in GitBook

UML Diagrams rendering using PlantUML.

[![Build Status](https://travis-ci.org/GitbookIO/plugin-puml.png?branch=master)](https://travis-ci.org/GitbookIO/plugin-puml)
[![NPM version](https://badge.fury.io/js/gitbook-plugin-puml.svg)](http://badge.fury.io/js/gitbook-plugin-puml)


Configure the plugin in your `book.json`:

```js
{
    "plugins": ["puml"]
}
```

Then in your content:

```md
This is a diagram:

{% plantuml %}
Bob->Alice : hello
{% endplantuml %}
```

The plugin will replace the `{% plantuml %}` by SVG images (and PNG images for ebook output).
