# gitbook-plugin-include-csv

## What is it?
A Gitbook plugin for including and rending CSV file in your book.

## How to install it?
You can install via NPM: 

```sh
$ npm install --save gitbook-plugin-include-csv
```

And config your book.json file.

```json
{
    "plugins": ["include-csv"]
}
```

## How to use it?

Insert `includeCsv` tag into your Gitbook pages.

```
{% includeCsv src="./hoge.csv" %}{% endincludeCsv %}
```

![example1](./doc/sample_file.png "example")


```
{% includeCsv %}
hoge,fuga
a,0001
b,002
{% endincludeCsv %}
```

![example2](./doc/sample_tagbody.png "example")


### Arguments

| name      | description                           | example           |
|-----------|---------------------------------------|-------------------|
| src       | The file path for including CSV file. | "./filename.csv"  |
| encoding  | character encoding in CSV file.       | "shift_jis"       |
| useHeader | use 1st row for header.               | "true"            |
| exHeaders | define column headers.                | "col01,col02"     |
| limit     | load limit number of rows.            | 5                 |

#### usage example

Show the table from csv file, 1st row is header, file's encoding is shift_jis(japanese traditional encoding format).
```
{% includeCsv src="./sample_records.csv", encoding="shift_jis", useHeader="true" %}{% endincludeCsv %}
```

![example3](./doc/sample_file_withoption.png "example")


Show the table from tag body, is row is header.
```
{% includeCsv useHeader="true" %}
c1,c2,c3
1,1,1
2,2,2
{% endincludeCsv %}
```

![example4](./doc/sample_tagbody_withoption.png "example")

Show the table from csv file, define column headers directory, set limit of rows.

```
{% includeCsv 
    src="./train.1.csv", 
    exHeaders="PassengerId,Survived,Pclass,Name,Sex,Age,SibSp,Parch,Ticket,Fare,Cabin,Embarked",
    limit=2 %}
{% endincludeCsv %}
```

![example5](./doc/sample_exheader_limit.png "example")
